// SPDX-License-Identifier: GPL-2.0-only

/*
 * logrelay: syslog of the stock services -> OpenWrt's logd, filtered.
 *
 * The stock libc in /rtk sends syslog() to /var/slg instead of /dev/log
 * (patched at build time by scripts/patch-vendor.sh): /rtk/dev is the
 * system /dev, so a stock syslog daemon there would take /dev/log from
 * logd, and without one the stock services' debug chatter (VoIP_maserati
 * logs about a line a second at info level) would flood logd's ring.
 * This relay listens on that socket and forwards every message up to a
 * priority (default 5 = notice, what the stock `slogd -l 5` kept) to
 * logd's /dev/log unchanged.
 *
 *   logrelay <listen-socket> <forward-socket> [max-level 0..7]
 *
 * Runs on the OpenWrt side as a procd instance of rtk-vendor; built
 * static (zig cc -target aarch64-linux-musl).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>

/* "<PRI>..." -> PRI & 7, or -1 without a valid header */
static int msg_level(const char *m, size_t n)
{
	size_t i;
	int pri = 0;

	if (n < 3 || m[0] != '<')
		return -1;
	for (i = 1; i < n && i < 5 && m[i] >= '0' && m[i] <= '9'; i++)
		pri = pri * 10 + (m[i] - '0');
	if (i == 1 || i >= n || m[i] != '>')
		return -1;
	return pri & 7;
}

static int unix_addr(struct sockaddr_un *a, const char *path)
{
	memset(a, 0, sizeof(*a));
	a->sun_family = AF_UNIX;
	if (strlen(path) >= sizeof(a->sun_path))
		return -1;
	strcpy(a->sun_path, path);
	return 0;
}

int main(int argc, char **argv)
{
	struct sockaddr_un in, out;
	char buf[8192];
	int s, o, max = 5;
	ssize_t n;

	if (argc < 3 || unix_addr(&in, argv[1]) || unix_addr(&out, argv[2])) {
		fputs("usage: logrelay <listen-socket> <forward-socket> [max-level 0..7]\n", stderr);
		return 2;
	}
	if (argc > 3)
		max = atoi(argv[3]);

	s = socket(AF_UNIX, SOCK_DGRAM, 0);
	o = socket(AF_UNIX, SOCK_DGRAM, 0);
	if (s < 0 || o < 0) {
		perror("logrelay: socket");
		return 1;
	}
	unlink(argv[1]);
	if (bind(s, (struct sockaddr *)&in, sizeof(in)) < 0) {
		perror("logrelay: bind");
		return 1;
	}
	chmod(argv[1], 0666);

	for (;;) {
		n = recv(s, buf, sizeof(buf), 0);
		if (n <= 0) {
			if (n < 0 && errno != EINTR)
				sleep(1);
			continue;
		}
		/* messages without a <PRI> header pass (glibc always sends one) */
		if (msg_level(buf, (size_t)n) > max)
			continue;
		/* by path each time: logd re-creates /dev/log when it restarts */
		sendto(o, buf, (size_t)n, MSG_DONTWAIT, (struct sockaddr *)&out, sizeof(out));
	}
}
