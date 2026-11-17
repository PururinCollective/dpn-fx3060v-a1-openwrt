// SPDX-License-Identifier: GPL-2.0-only

/*
 * NijikaWrt neighbor announcements: the LLDP and MNDP frames.
 *
 * The frames nbannounce sends out of each LAN port, so the switch or router
 * on that port lists this router as a neighbor, with its addresses, whatever
 * subnet they are in:
 *
 *   LLDP (IEEE 802.1AB): to 01:80:c2:00:00:0e, read by any switch or router
 *       (MikroTik, Cisco, Juniper, lldpd on Linux).
 *   MNDP (MikroTik Neighbor Discovery): a UDP broadcast to port 5678, what
 *       Winbox and /ip neighbor show (Identity, Version, Board, Uptime ...).
 *
 * Both are built as whole Ethernet frames for a packet socket on the port
 * device: no address and no route is needed to send them.
 *
 * Pure functions on a facts structure, no system calls, so the host test
 * (tests/announce_test.c) checks the exact bytes. The same frame builder as
 * the Nijika Luna announce (rtl9601-nijika-luna, by the same author).
 */
#ifndef NJ_ANNOUNCE_H
#define NJ_ANNOUNCE_H

#define NB_IP4_MAX   6
#define NB_FRAME_MAX 1514

/* LLDP system capabilities (802.1AB table 8-4). */
#define NB_CAP_BRIDGE 0x0004
#define NB_CAP_WLAN   0x0008
#define NB_CAP_ROUTER 0x0010

struct nb_facts {
	unsigned char mac[6];
	unsigned long mgmt_ifindex;    /* of the device holding the addresses */
	char port_if[16];              /* the device the frames leave by */
	char port_desc[64];
	char name[64];                 /* identity / system name */
	char platform[16];
	char board[32];
	char version[64];
	char swid[32];
	char desc[200];                /* LLDP system description */
	unsigned caps;                 /* LLDP system capabilities, all enabled */
	unsigned char ip4[NB_IP4_MAX][4];  /* [0] is the primary address */
	int n_ip4;
	unsigned long uptime;          /* seconds */
};

/* Each returns the frame length, or -1 when it does not fit in max. */
int nb_lldp_frame(const struct nb_facts *f, int ttl, unsigned char *buf, int max);
int nb_mndp_frame(const struct nb_facts *f, unsigned seq, unsigned char *buf, int max);

#endif
