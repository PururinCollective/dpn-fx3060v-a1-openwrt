// SPDX-License-Identifier: GPL-2.0-only

/*
 * nbannounce: LLDP and MikroTik MNDP neighbor announcements out of the LAN
 * ports, so the switch or router on a port lists this router with its LAN
 * addresses, whatever subnet they are in (frames: announce.c).
 *
 *   nbannounce show|once|run [options]
 *     show  print what is sent
 *     once  send one round now
 *     run   send every 30 s, and within 5 s of a change of an address, the
 *           host name or the port set (the procd instance of nijika-announce)
 *
 *   -b DEV          device holding the addresses and the MAC (br0)
 *   -p DEV[=LABEL]  a port the frames leave by, LABEL its LLDP port
 *                   description (LAN1); repeatable. None: every member of
 *                   the -b bridge except wlan* (read again on every tick)
 *   -l 0|1, -m 0|1  LLDP, MNDP (default 1)
 *   -P -V -B -S -D  platform, version, board, software ID, description
 *   -c CAPS         LLDP system capabilities (default router, bridge, WLAN)
 *
 * The identity is the host name, read on every tick. A frame is sent from a
 * packet socket on the port device: it leaves by that switch port only and
 * needs no route. Runs on the OpenWrt side; built static (zig cc -target
 * aarch64-linux-musl) by scripts/build-helpers.sh.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#include <unistd.h>
#include <dirent.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/sysinfo.h>
#include <linux/if_packet.h>
#include "announce.h"

#define NB_TTL     120   /* seconds a receiver keeps the entry */
#define NB_EVERY   30    /* seconds between rounds */
#define NB_TICK    5     /* seconds between checks for a change */
#define NB_PORTS   16

struct port {
	char dev[16];
	char label[64];
	int err;             /* the last send failed (logged once) */
};

static struct {
	const char *mgmt;
	int lldp, mndp;
	const char *platform, *version, *board, *swid, *desc;
	unsigned caps;
	struct port fixed[NB_PORTS];
	int n_fixed;
} cfg = {
	.mgmt = "br0", .lldp = 1, .mndp = 1,
	.platform = "NijikaWrt", .version = "", .board = "", .swid = "", .desc = "",
	.caps = NB_CAP_ROUTER | NB_CAP_BRIDGE | NB_CAP_WLAN,
};

static struct port ports[NB_PORTS];
static int n_ports;
static int sock = -1;   /* packet socket, sends */
static int ctl = -1;    /* interface ioctls */

/* Copy, cut to fit max (with the terminating zero). */
static void scopy(char *dst, const char *src, size_t max)
{
	size_t i = 0;

	while (src && src[i] && i + 1 < max) {
		dst[i] = src[i];
		i++;
	}
	dst[i] = 0;
}

static int dev_flags(const char *dev)
{
	struct ifreq ifr;

	memset(&ifr, 0, sizeof ifr);
	scopy(ifr.ifr_name, dev, sizeof ifr.ifr_name);
	if (ioctl(ctl, SIOCGIFFLAGS, &ifr) < 0)
		return -1;
	return ifr.ifr_flags;
}

static int dev_mac(const char *dev, unsigned char *mac)
{
	struct ifreq ifr;

	memset(&ifr, 0, sizeof ifr);
	scopy(ifr.ifr_name, dev, sizeof ifr.ifr_name);
	if (ioctl(ctl, SIOCGIFHWADDR, &ifr) < 0)
		return -1;
	memcpy(mac, ifr.ifr_hwaddr.sa_data, 6);
	return 0;
}

/* The IPv4 addresses of dev and its aliases (dev:1 ...), dev first. */
static int dev_ip4(const char *dev, unsigned char ip[][4], int max)
{
	struct ifaddrs *ifa, *a;
	size_t dl = strlen(dev);
	int n = 0;

	if (getifaddrs(&ifa) < 0)
		return 0;
	for (int pass = 0; pass < 2; pass++)
		for (a = ifa; a && n < max; a = a->ifa_next) {
			int primary, alias;

			if (!a->ifa_addr || a->ifa_addr->sa_family != AF_INET)
				continue;
			primary = strcmp(a->ifa_name, dev) == 0;
			alias = strncmp(a->ifa_name, dev, dl) == 0 && a->ifa_name[dl] == ':';
			if ((pass == 0 && !primary) || (pass == 1 && !alias))
				continue;
			memcpy(ip[n++], &((struct sockaddr_in *)a->ifa_addr)->sin_addr, 4);
		}
	freeifaddrs(ifa);
	return n;
}

static int port_cmp(const void *a, const void *b)
{
	return strcmp(((const struct port *)a)->dev, ((const struct port *)b)->dev);
}

/* The ports of this tick: the -p list, else the wired members of the
 * bridge. The error flag of a port is kept across ticks. */
static void ports_scan(void)
{
	struct port now[NB_PORTS];
	int n = 0;

	if (cfg.n_fixed) {
		memcpy(now, cfg.fixed, sizeof now);
		n = cfg.n_fixed;
	} else {
		char p[64];
		DIR *d;
		struct dirent *e;

		snprintf(p, sizeof p, "/sys/class/net/%s/brif", cfg.mgmt);
		d = opendir(p);
		while (d && (e = readdir(d)) && n < NB_PORTS) {
			if (e->d_name[0] == '.' || strncmp(e->d_name, "wlan", 4) == 0)
				continue;
			memset(&now[n], 0, sizeof now[n]);
			scopy(now[n].dev, e->d_name, sizeof now[n].dev);
			n++;
		}
		if (d)
			closedir(d);
		qsort(now, (size_t)n, sizeof now[0], port_cmp);
	}
	for (int i = 0; i < n; i++)
		for (int k = 0; k < n_ports; k++)
			if (strcmp(now[i].dev, ports[k].dev) == 0)
				now[i].err = ports[k].err;
	memcpy(ports, now, sizeof ports);
	n_ports = n;
}

/* Everything the frames say except the port, read again on every tick. */
static void gather(struct nb_facts *f)
{
	struct sysinfo si;
	char host[64] = "";

	memset(f, 0, sizeof *f);
	if (dev_mac(cfg.mgmt, f->mac) < 0 && n_ports)
		dev_mac(ports[0].dev, f->mac);
	f->mgmt_ifindex = if_nametoindex(cfg.mgmt);
	f->n_ip4 = dev_ip4(cfg.mgmt, f->ip4, NB_IP4_MAX);
	if (sysinfo(&si) == 0)
		f->uptime = (unsigned long)si.uptime;
	gethostname(host, sizeof host - 1);
	scopy(f->name, host[0] ? host : "NijikaWrt", sizeof f->name);
	scopy(f->platform, cfg.platform, sizeof f->platform);
	scopy(f->version, cfg.version, sizeof f->version);
	scopy(f->board, cfg.board, sizeof f->board);
	scopy(f->swid, cfg.swid, sizeof f->swid);
	scopy(f->desc, cfg.desc, sizeof f->desc);
	f->caps = cfg.caps;
}

static int send_frame(int ifindex, const unsigned char *frame, int len)
{
	struct sockaddr_ll sll;

	memset(&sll, 0, sizeof sll);
	sll.sll_family = AF_PACKET;
	sll.sll_ifindex = ifindex;
	sll.sll_halen = 6;
	memcpy(sll.sll_addr, frame, 6);
	if (sendto(sock, frame, (size_t)len, 0, (struct sockaddr *)&sll, sizeof sll) < 0)
		return -errno;
	return 0;
}

/* One round on every port that is up; returns the number of frames sent.
 * A failing port is logged once, and again when it recovers. */
static int round_send(const struct nb_facts *base, unsigned *seq, int quiet)
{
	unsigned char fr[NB_FRAME_MAX];
	struct nb_facts f;
	int sent = 0;

	for (int i = 0; i < n_ports; i++) {
		struct port *p = &ports[i];
		int ifi = (int)if_nametoindex(p->dev), flags = dev_flags(p->dev), rc = 0, n;

		if (!ifi || flags < 0 || !(flags & IFF_UP))
			continue;
		f = *base;
		scopy(f.port_if, p->dev, sizeof f.port_if);
		scopy(f.port_desc, p->label, sizeof f.port_desc);
		if (cfg.lldp) {
			n = nb_lldp_frame(&f, NB_TTL, fr, sizeof fr);
			rc = n > 0 ? send_frame(ifi, fr, n) : -EMSGSIZE;
			sent += rc == 0;
		}
		if (cfg.mndp) {
			int r;

			n = nb_mndp_frame(&f, ++*seq, fr, sizeof fr);
			r = n > 0 ? send_frame(ifi, fr, n) : -EMSGSIZE;
			sent += r == 0;
			if (!rc)
				rc = r;
		}
		if (rc && !p->err && !quiet)
			printf("announce: send on %s failed: %s\n", p->dev, strerror(-rc));
		else if (!rc && p->err && !quiet)
			printf("announce: %s sending again\n", p->dev);
		p->err = rc != 0;
	}
	fflush(stdout);
	return sent;
}

static void ip4_print(const struct nb_facts *f, const char *sep)
{
	char a[INET_ADDRSTRLEN];

	if (!f->n_ip4)
		printf("-");
	for (int i = 0; i < f->n_ip4; i++) {
		inet_ntop(AF_INET, f->ip4[i], a, sizeof a);
		printf("%s%s", i ? sep : "", a);
	}
}

static void ports_print(const char *sep)
{
	if (!n_ports)
		printf("-");
	for (int i = 0; i < n_ports; i++) {
		printf("%s%s", i ? sep : "", ports[i].dev);
		if (ports[i].label[0])
			printf(" (%s)", ports[i].label);
	}
}

static void show(const struct nb_facts *f)
{
	printf("LLDP        : %s\n", cfg.lldp ? "Enabled" : "Disabled");
	printf("MNDP        : %s\n", cfg.mndp ? "Enabled" : "Disabled");
	printf("Ports       : ");
	ports_print(", ");
	printf("\nMAC Address : %02x:%02x:%02x:%02x:%02x:%02x\n",
	       f->mac[0], f->mac[1], f->mac[2], f->mac[3], f->mac[4], f->mac[5]);
	printf("IP Address  : ");
	ip4_print(f, ", ");
	printf(" (%s)\n", cfg.mgmt);
	printf("Identity    : %s\n", f->name);
	printf("Platform    : %s\n", f->platform);
	printf("Version     : %s\n", f->version);
	printf("Board       : %s\n", f->board);
	printf("Software ID : %s\n", f->swid);
	printf("Description : %s\n", f->desc);
	printf("Interval    : %d s, TTL %d s\n", NB_EVERY, NB_TTL);
}

static void log_state(const struct nb_facts *f, const char *what)
{
	printf("announce: %s lldp=%s mndp=%s ports=", what, cfg.lldp ? "on" : "off",
	       cfg.mndp ? "on" : "off");
	ports_print(",");
	printf(" ip=");
	ip4_print(f, ",");
	printf(" name=%s\n", f->name);
	fflush(stdout);
}

/* The facts without the uptime, and the port set: a change in any of them
 * is sent at once, not at the next NB_EVERY. */
static int same(const struct nb_facts *a, const struct nb_facts *b,
		const char *pa, const char *pb)
{
	struct nb_facts x = *a, y = *b;

	x.uptime = y.uptime = 0;
	return memcmp(&x, &y, sizeof x) == 0 && strcmp(pa, pb) == 0;
}

static void port_set(char *buf, size_t max)
{
	buf[0] = 0;
	for (int i = 0; i < n_ports; i++) {
		size_t l = strlen(buf);

		scopy(buf + l, ports[i].dev, max - l);
		l = strlen(buf);
		scopy(buf + l, ",", max - l);
	}
}

static int run(void)
{
	struct nb_facts f, last;
	char set[NB_PORTS * 17], last_set[NB_PORTS * 17] = "";
	struct timespec ts;
	time_t sent_at = 0;
	unsigned seq = 0;
	int first = 1;

	memset(&last, 0, sizeof last);
	for (;;) {
		int changed;

		ports_scan();
		gather(&f);
		port_set(set, sizeof set);
		changed = first || !same(&f, &last, set, last_set);
		clock_gettime(CLOCK_MONOTONIC, &ts);
		if (changed)
			log_state(&f, first ? "started," : "changed,");
		if (changed || ts.tv_sec - sent_at >= NB_EVERY) {
			round_send(&f, &seq, 0);
			sent_at = ts.tv_sec;
		}
		last = f;
		memcpy(last_set, set, sizeof last_set);
		first = 0;
		sleep(NB_TICK);
	}
	return 0;
}

static int usage(void)
{
	fprintf(stderr, "usage: nbannounce show|once|run [-b dev] [-p dev[=label]]... [-l 0|1] [-m 0|1]\n"
		"                  [-P platform] [-V version] [-B board] [-S swid] [-D desc] [-c caps]\n");
	return 2;
}

int main(int argc, char **argv)
{
	struct nb_facts f;
	const char *cmd;
	int c;

	if (argc < 2)
		return usage();
	cmd = argv[1];
	optind = 2;
	while ((c = getopt(argc, argv, "b:p:l:m:P:V:B:S:D:c:")) != -1) {
		switch (c) {
		case 'b': cfg.mgmt = optarg; break;
		case 'l': cfg.lldp = atoi(optarg) != 0; break;
		case 'm': cfg.mndp = atoi(optarg) != 0; break;
		case 'P': cfg.platform = optarg; break;
		case 'V': cfg.version = optarg; break;
		case 'B': cfg.board = optarg; break;
		case 'S': cfg.swid = optarg; break;
		case 'D': cfg.desc = optarg; break;
		case 'c': cfg.caps = (unsigned)strtoul(optarg, NULL, 0) & 0xffff; break;
		case 'p': {
			struct port *p;
			char *eq = strchr(optarg, '=');

			if (cfg.n_fixed >= NB_PORTS)
				break;
			p = &cfg.fixed[cfg.n_fixed++];
			memset(p, 0, sizeof *p);
			if (eq) {
				*eq = 0;
				scopy(p->label, eq + 1, sizeof p->label);
			}
			scopy(p->dev, optarg, sizeof p->dev);
			break;
		}
		default:
			return usage();
		}
	}

	ctl = socket(AF_INET, SOCK_DGRAM, 0);
	if (strcmp(cmd, "show") == 0) {
		ports_scan();
		gather(&f);
		show(&f);
		return 0;
	}
	if (strcmp(cmd, "once") != 0 && strcmp(cmd, "run") != 0)
		return usage();

	/* protocol 0: the socket sends, it receives nothing */
	sock = socket(AF_PACKET, SOCK_RAW, 0);
	if (sock < 0) {
		fprintf(stderr, "nbannounce: packet socket: %s\n", strerror(errno));
		return 1;
	}
	if (strcmp(cmd, "run") == 0)
		return run();

	ports_scan();
	gather(&f);
	if (!cfg.lldp && !cfg.mndp) {
		printf("LLDP and MNDP are disabled, nothing sent.\n");
		return 0;
	}
	c = round_send(&f, &(unsigned){ 0 }, 0);
	printf("%d frame(s) sent on ", c);
	ports_print(", ");
	printf(".\n");
	return c ? 0 : 1;
}
