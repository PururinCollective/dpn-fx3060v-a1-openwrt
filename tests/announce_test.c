// SPDX-License-Identifier: GPL-2.0-only

/*
 * NijikaWrt neighbor announcements on the host: the LLDP and MNDP frames of
 * package/nijika/src/announce.c, byte for byte, walked TLV by TLV the way a
 * receiver reads them, and the IPv4 and UDP checksums of the MNDP frame
 * verified independently (tests/run.sh announce).
 *
 *     cc -Ipackage/nijika/src -o announce_test tests/announce_test.c package/nijika/src/announce.c
 */
#include <stdio.h>
#include <string.h>
#include "announce.h"

static int pass, fail;

#define CHECK(what, cond) do { \
	if (cond) { pass++; printf("ok    %s\n", what); } \
	else { fail++; printf("FAIL  %s\n", what); } \
} while (0)

static void facts(struct nb_facts *f)
{
	static const unsigned char mac[6] = { 0x02, 0x00, 0x5e, 0x10, 0x20, 0x30 };

	memset(f, 0, sizeof *f);
	memcpy(f->mac, mac, 6);
	f->mgmt_ifindex = 7;
	strcpy(f->port_if, "eth0.2");
	strcpy(f->port_desc, "LAN1");
	strcpy(f->name, "NijikaWrt");
	strcpy(f->platform, "NijikaWrt");
	strcpy(f->board, "DPN-FX3060V (A1)");
	strcpy(f->version, "r40");
	strcpy(f->swid, "bank0");
	strcpy(f->desc, "NijikaWrt r40, OpenWrt 25.12.5, D-Link DPN-FX3060V (A1)");
	f->caps = NB_CAP_ROUTER | NB_CAP_BRIDGE | NB_CAP_WLAN;
	f->ip4[0][0] = 192; f->ip4[0][1] = 168; f->ip4[0][2] = 1; f->ip4[0][3] = 1;
	f->ip4[1][0] = 169; f->ip4[1][1] = 254; f->ip4[1][2] = 1; f->ip4[1][3] = 1;
	f->n_ip4 = 2;
	f->uptime = 0x01020304;
}

/* Finds LLDP TLV `type` (the first, or the nth for n > 0); returns its value
 * and length, or NULL. Fails the walk when a TLV runs past the frame. */
static const unsigned char *lldp_tlv(const unsigned char *b, int len, unsigned type, int nth, int *tl)
{
	int at = 14;

	while (at + 2 <= len) {
		unsigned h = (unsigned)(b[at] << 8 | b[at + 1]);
		unsigned t = h >> 9;
		int l = (int)(h & 0x1ff);

		if (at + 2 + l > len)
			return NULL;
		if (t == type && nth-- == 0) {
			*tl = l;
			return b + at + 2;
		}
		if (t == 0)
			return NULL;
		at += 2 + l;
	}
	return NULL;
}

static unsigned sum16(const unsigned char *p, int n, unsigned long s)
{
	for (int i = 0; i + 1 < n; i += 2)
		s += (unsigned)(p[i] << 8 | p[i + 1]);
	if (n & 1)
		s += (unsigned)p[n - 1] << 8;
	while (s >> 16)
		s = (s & 0xffff) + (s >> 16);
	return (unsigned)s;
}

static const unsigned char *mndp_tlv(const unsigned char *p, int len, unsigned type, int *tl)
{
	int at = 4;

	while (at + 4 <= len) {
		unsigned t = (unsigned)(p[at] << 8 | p[at + 1]);
		int l = p[at + 2] << 8 | p[at + 3];

		if (at + 4 + l > len)
			return NULL;
		if (t == type) {
			*tl = l;
			return p + at + 4;
		}
		at += 4 + l;
	}
	return NULL;
}

static int str_is(const unsigned char *v, int l, const char *s)
{
	return v && l == (int)strlen(s) && memcmp(v, s, (size_t)l) == 0;
}

static void test_lldp(void)
{
	struct nb_facts f;
	unsigned char b[NB_FRAME_MAX];
	const unsigned char *v;
	int n, l;

	facts(&f);
	n = nb_lldp_frame(&f, 120, b, sizeof b);
	CHECK("lldp: built", n > 0);
	CHECK("lldp: to the nearest-bridge group", memcmp(b, "\x01\x80\xc2\x00\x00\x0e", 6) == 0);
	CHECK("lldp: from the router MAC", memcmp(b + 6, f.mac, 6) == 0);
	CHECK("lldp: ethertype 88cc", b[12] == 0x88 && b[13] == 0xcc);
	CHECK("lldp: first TLV is the chassis ID", b[14] >> 1 == 1);
	v = lldp_tlv(b, n, 1, 0, &l);
	CHECK("lldp: chassis ID subtype 4, the MAC", v && l == 7 && v[0] == 4 && memcmp(v + 1, f.mac, 6) == 0);
	v = lldp_tlv(b, n, 2, 0, &l);
	CHECK("lldp: port ID subtype 5, eth0.2", v && l == 7 && v[0] == 5 && memcmp(v + 1, "eth0.2", 6) == 0);
	v = lldp_tlv(b, n, 3, 0, &l);
	CHECK("lldp: TTL 120", v && l == 2 && v[0] == 0 && v[1] == 120);
	v = lldp_tlv(b, n, 4, 0, &l);
	CHECK("lldp: port description", str_is(v, l, f.port_desc));
	v = lldp_tlv(b, n, 5, 0, &l);
	CHECK("lldp: system name", str_is(v, l, "NijikaWrt"));
	v = lldp_tlv(b, n, 6, 0, &l);
	CHECK("lldp: system description", str_is(v, l, f.desc));
	v = lldp_tlv(b, n, 7, 0, &l);
	CHECK("lldp: capabilities router, bridge, WLAN, all enabled",
	      v && l == 4 && v[0] == 0 && v[1] == 0x1c && v[2] == 0 && v[3] == 0x1c);
	v = lldp_tlv(b, n, 8, 0, &l);
	CHECK("lldp: management address 192.168.1.1, ifIndex 7",
	      v && l == 12 && v[0] == 5 && v[1] == 1 && memcmp(v + 2, "\xc0\xa8\x01\x01", 4) == 0 &&
	      v[6] == 2 && memcmp(v + 7, "\x00\x00\x00\x07", 4) == 0 && v[11] == 0);
	v = lldp_tlv(b, n, 8, 1, &l);
	CHECK("lldp: second management address 169.254.1.1",
	      v && l == 12 && memcmp(v + 2, "\xa9\xfe\x01\x01", 4) == 0);
	CHECK("lldp: no third management address", !lldp_tlv(b, n, 8, 2, &l));
	v = lldp_tlv(b, n, 0, 0, &l);
	CHECK("lldp: ends with End of LLDPDU", v && l == 0);

	f.n_ip4 = 0;
	f.desc[0] = 0;
	n = nb_lldp_frame(&f, 120, b, sizeof b);
	CHECK("lldp: no address, no management TLV", n > 0 && !lldp_tlv(b, n, 8, 0, &l));
	CHECK("lldp: empty description left out", n > 0 && !lldp_tlv(b, n, 6, 0, &l));
	CHECK("lldp: short frame padded to 60", n >= 60);
	CHECK("lldp: too small a buffer is refused", nb_lldp_frame(&f, 120, b, 40) == -1);
}

static void test_mndp(void)
{
	struct nb_facts f;
	unsigned char b[NB_FRAME_MAX];
	const unsigned char *ip, *udp, *p, *v;
	int n, l, ulen;

	facts(&f);
	n = nb_mndp_frame(&f, 0x1234, b, sizeof b);
	CHECK("mndp: built", n > 0);
	CHECK("mndp: to broadcast", memcmp(b, "\xff\xff\xff\xff\xff\xff", 6) == 0);
	CHECK("mndp: ethertype IPv4", b[12] == 0x08 && b[13] == 0x00);
	ip = b + 14;
	CHECK("mndp: IPv4, 20-byte header, UDP", ip[0] == 0x45 && ip[9] == 17);
	CHECK("mndp: from the primary address", memcmp(ip + 12, "\xc0\xa8\x01\x01", 4) == 0);
	CHECK("mndp: to 255.255.255.255", memcmp(ip + 16, "\xff\xff\xff\xff", 4) == 0);
	CHECK("mndp: IPv4 header checksum", sum16(ip, 20, 0) == 0xffff);
	udp = ip + 20;
	ulen = udp[4] << 8 | udp[5];
	CHECK("mndp: IP total length = 20 + UDP length", (ip[2] << 8 | ip[3]) == 20 + ulen);
	CHECK("mndp: ports 5678 to 5678", udp[0] == 0x16 && udp[1] == 0x2e && udp[2] == 0x16 && udp[3] == 0x2e);
	{
		unsigned long s = 0;

		s += sum16(ip + 12, 8, 0);
		s += 17 + (unsigned)ulen;
		CHECK("mndp: UDP checksum", sum16(udp, ulen, s) == 0xffff);
	}
	p = udp + 8;
	l = ulen - 8;
	CHECK("mndp: header zero, sequence 0x1234", p[0] == 0 && p[1] == 0 && p[2] == 0x12 && p[3] == 0x34);
	v = mndp_tlv(p, l, 1, &n);
	CHECK("mndp: MAC", v && n == 6 && memcmp(v, f.mac, 6) == 0);
	v = mndp_tlv(p, l, 5, &n);
	CHECK("mndp: identity", str_is(v, n, "NijikaWrt"));
	v = mndp_tlv(p, l, 7, &n);
	CHECK("mndp: version", str_is(v, n, f.version));
	v = mndp_tlv(p, l, 8, &n);
	CHECK("mndp: platform", str_is(v, n, "NijikaWrt"));
	v = mndp_tlv(p, l, 10, &n);
	CHECK("mndp: uptime little-endian", v && n == 4 && v[0] == 4 && v[1] == 3 && v[2] == 2 && v[3] == 1);
	v = mndp_tlv(p, l, 11, &n);
	CHECK("mndp: software ID", str_is(v, n, "bank0"));
	v = mndp_tlv(p, l, 12, &n);
	CHECK("mndp: board", str_is(v, n, "DPN-FX3060V (A1)"));
	v = mndp_tlv(p, l, 14, &n);
	CHECK("mndp: unpack none", v && n == 1 && v[0] == 0);
	v = mndp_tlv(p, l, 16, &n);
	CHECK("mndp: interface name", str_is(v, n, "eth0.2"));
	v = mndp_tlv(p, l, 17, &n);
	CHECK("mndp: IPv4 address is the primary", v && n == 4 && memcmp(v, "\xc0\xa8\x01\x01", 4) == 0);

	f.n_ip4 = 0;
	n = nb_mndp_frame(&f, 1, b, sizeof b);
	ip = b + 14;
	udp = ip + 20;
	ulen = udp[4] << 8 | udp[5];
	CHECK("mndp: no address, from 0.0.0.0", n > 0 && memcmp(ip + 12, "\0\0\0\0", 4) == 0);
	CHECK("mndp: no address, no IPv4 TLV", n > 0 && !mndp_tlv(udp + 8, ulen - 8, 17, &l));
	CHECK("mndp: too small a buffer is refused", nb_mndp_frame(&f, 1, b, 80) == -1);
}

int main(void)
{
	test_lldp();
	test_mndp();
	printf("%d passed, %d failed\n", pass, fail);
	return fail != 0;
}
