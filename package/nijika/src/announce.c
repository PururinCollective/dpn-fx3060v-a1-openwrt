// SPDX-License-Identifier: GPL-2.0-only

/*
 * NijikaWrt neighbor announcements: the LLDP and MNDP frames (announce.h).
 * No system calls: it builds bytes, so the same file links into nbannounce
 * and into the host test (tests/announce_test.c).
 */
#include "announce.h"

/* A writer over buf: once a put does not fit, `bad` sticks and the frame is
 * refused whole, never sent cut short. */
struct w {
	unsigned char *b;
	int n, max, bad;
};

static int slen(const char *s)
{
	int n = 0;

	while (s[n])
		n++;
	return n;
}

static void put8(struct w *w, unsigned v)
{
	if (w->n + 1 > w->max) {
		w->bad = 1;
		return;
	}
	w->b[w->n++] = (unsigned char)v;
}

static void put16(struct w *w, unsigned v)
{
	put8(w, v >> 8);
	put8(w, v);
}

static void putn(struct w *w, const void *p, int n)
{
	const unsigned char *s = p;

	for (int i = 0; i < n; i++)
		put8(w, s[i]);
}

static void set16(struct w *w, int at, unsigned v)
{
	if (at + 2 <= w->n) {
		w->b[at] = (unsigned char)(v >> 8);
		w->b[at + 1] = (unsigned char)v;
	}
}

/* Ethernet frames shorter than 60 bytes (no FCS) are padded with zeros. */
static void pad60(struct w *w)
{
	while (!w->bad && w->n < 60)
		put8(w, 0);
}

/* ---- LLDP ------------------------------------------------------------------ */

static const unsigned char lldp_dst[6] = { 0x01, 0x80, 0xc2, 0x00, 0x00, 0x0e };

/* A TLV header: 7 bits of type, 9 of length. */
static void tlv(struct w *w, unsigned type, int len)
{
	if (len > 511) {
		w->bad = 1;
		return;
	}
	put16(w, (type << 9) | (unsigned)len);
}

/* A string TLV, cut at 255 bytes (the most 802.1AB allows for each of these). */
static void tlv_str(struct w *w, unsigned type, const char *s)
{
	int n = slen(s);

	if (n > 255)
		n = 255;
	tlv(w, type, n);
	putn(w, s, n);
}

int nb_lldp_frame(const struct nb_facts *f, int ttl, unsigned char *buf, int max)
{
	struct w w = { buf, 0, max, 0 };
	int n;

	putn(&w, lldp_dst, 6);
	putn(&w, f->mac, 6);
	put16(&w, 0x88cc);

	/* Chassis ID, subtype 4: a MAC address. */
	tlv(&w, 1, 7);
	put8(&w, 4);
	putn(&w, f->mac, 6);

	/* Port ID, subtype 5: an interface name. */
	n = slen(f->port_if);
	if (n > 255)
		n = 255;
	tlv(&w, 2, 1 + n);
	put8(&w, 5);
	putn(&w, f->port_if, n);

	/* Time to live, seconds. */
	tlv(&w, 3, 2);
	put16(&w, (unsigned)ttl);

	if (f->port_desc[0])
		tlv_str(&w, 4, f->port_desc);
	if (f->name[0])
		tlv_str(&w, 5, f->name);
	if (f->desc[0])
		tlv_str(&w, 6, f->desc);

	/* System capabilities: what it can be, then what is on (the same). */
	tlv(&w, 7, 4);
	put16(&w, f->caps);
	put16(&w, f->caps);

	/* One management address TLV per IPv4 address: address string length
	 * (subtype + 4), subtype 1 IPv4, the address, interface numbering
	 * subtype 2 (ifIndex), the ifIndex, an empty OID. */
	for (int i = 0; i < f->n_ip4 && i < NB_IP4_MAX; i++) {
		tlv(&w, 8, 12);
		put8(&w, 5);
		put8(&w, 1);
		putn(&w, f->ip4[i], 4);
		put8(&w, 2);
		put16(&w, (unsigned)(f->mgmt_ifindex >> 16));
		put16(&w, (unsigned)(f->mgmt_ifindex & 0xffff));
		put8(&w, 0);
	}

	tlv(&w, 0, 0);   /* End of LLDPDU */
	pad60(&w);
	return w.bad ? -1 : w.n;
}

/* ---- MNDP ------------------------------------------------------------------ */

/* MNDP type numbers, as RouterOS sends them and the Wireshark dissector
 * (packet-mndp.c) names them. */
#define MNDP_MAC       1
#define MNDP_IDENTITY  5
#define MNDP_VERSION   7
#define MNDP_PLATFORM  8
#define MNDP_UPTIME    10
#define MNDP_SWID      11
#define MNDP_BOARD     12
#define MNDP_UNPACK    14
#define MNDP_IFNAME    16
#define MNDP_IPV4      17
#define MNDP_PORT      5678

/* An MNDP TLV: 16-bit type and length, big-endian, then the value. */
static void mtlv(struct w *w, unsigned type, const void *p, int n)
{
	put16(w, type);
	put16(w, (unsigned)n);
	putn(w, p, n);
}

static void mtlv_str(struct w *w, unsigned type, const char *s)
{
	int n = slen(s);

	if (n > 255)
		n = 255;
	mtlv(w, type, s, n);
}

/* The ones-complement sum of RFC 1071, over len bytes, added to sum. */
static unsigned long csum_add(unsigned long sum, const unsigned char *p, int len)
{
	for (int i = 0; i + 1 < len; i += 2)
		sum += ((unsigned)p[i] << 8) | p[i + 1];
	if (len & 1)
		sum += (unsigned)p[len - 1] << 8;
	return sum;
}

static unsigned csum_fold(unsigned long sum)
{
	while (sum >> 16)
		sum = (sum & 0xffff) + (sum >> 16);
	return (unsigned)(~sum & 0xffff);
}

int nb_mndp_frame(const struct nb_facts *f, unsigned seq, unsigned char *buf, int max)
{
	static const unsigned char bcast[6] = { 0xff, 0xff, 0xff, 0xff, 0xff, 0xff };
	static const unsigned char any[4] = { 0, 0, 0, 0 };
	struct w w = { buf, 0, max, 0 };
	const unsigned char *src = f->n_ip4 > 0 ? f->ip4[0] : any;
	unsigned char up[4];
	unsigned char unpack = 0;
	int ip, udp, len;
	unsigned long sum;

	putn(&w, bcast, 6);
	putn(&w, f->mac, 6);
	put16(&w, 0x0800);

	/* IPv4: no options, TTL 64, UDP, from the primary address (0.0.0.0
	 * with none) to the limited broadcast. Lengths and checksum below. */
	ip = w.n;
	put8(&w, 0x45);
	put8(&w, 0);
	put16(&w, 0);                  /* total length */
	put16(&w, seq & 0xffff);       /* identification */
	put16(&w, 0x4000);             /* do not fragment */
	put8(&w, 64);
	put8(&w, 17);
	put16(&w, 0);                  /* header checksum */
	putn(&w, src, 4);
	put8(&w, 255); put8(&w, 255); put8(&w, 255); put8(&w, 255);

	udp = w.n;
	put16(&w, MNDP_PORT);
	put16(&w, MNDP_PORT);
	put16(&w, 0);                  /* length */
	put16(&w, 0);                  /* checksum */

	/* MNDP header: two bytes RouterOS sends as zero, then a sequence. */
	put16(&w, 0);
	put16(&w, seq & 0xffff);
	mtlv(&w, MNDP_MAC, f->mac, 6);
	mtlv_str(&w, MNDP_IDENTITY, f->name);
	mtlv_str(&w, MNDP_VERSION, f->version);
	mtlv_str(&w, MNDP_PLATFORM, f->platform);
	/* Uptime in seconds, little-endian: the one field MNDP does not send
	 * big-endian. */
	up[0] = (unsigned char)f->uptime;
	up[1] = (unsigned char)(f->uptime >> 8);
	up[2] = (unsigned char)(f->uptime >> 16);
	up[3] = (unsigned char)(f->uptime >> 24);
	mtlv(&w, MNDP_UPTIME, up, 4);
	mtlv_str(&w, MNDP_SWID, f->swid);
	mtlv_str(&w, MNDP_BOARD, f->board);
	mtlv(&w, MNDP_UNPACK, &unpack, 1);
	mtlv_str(&w, MNDP_IFNAME, f->port_if);
	if (f->n_ip4 > 0)
		mtlv(&w, MNDP_IPV4, f->ip4[0], 4);
	if (w.bad)
		return -1;

	len = w.n - ip;
	set16(&w, ip + 2, (unsigned)len);
	set16(&w, ip + 10, csum_fold(csum_add(0, w.b + ip, 20)));

	len = w.n - udp;
	set16(&w, udp + 4, (unsigned)len);
	/* UDP checksum over the pseudo-header (addresses, protocol, length)
	 * and the datagram; a result of 0 is sent as 0xffff. */
	sum = csum_add(0, w.b + ip + 12, 8);
	sum += 17 + (unsigned)len;
	sum = csum_add(sum, w.b + udp, len);
	sum = csum_fold(sum);
	set16(&w, udp + 6, sum ? (unsigned)sum : 0xffff);

	pad60(&w);
	return w.bad ? -1 : w.n;
}
