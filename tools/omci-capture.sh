#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-only

# NijikaWrt OMCI baseline capture (read-only). Writes /tmp/omci-baseline.txt
# with passwords / user names / LOID masked.
#
# Run it on the router (needs the vendor stack up; best at O5, a couple of
# minutes after the fibre came up, so the OLT has finished provisioning):
#   ssh root@192.168.0.1 sh -s < tools/omci-capture.sh
#   ssh root@192.168.0.1 cat /tmp/omci-baseline.txt > omci-baseline.txt
# Check the file before sharing it: OMCI can carry SIP numbers and the like
# in plain attributes (LargeString) that the mask does not catch.
#
# One ME class per request, with a pause in between: omcicli only waits a
# short while for omci_app, so a big answer ("mib get all", 200+ priority
# queues) comes back cut off and the rest spills into the next command.

# G.988 classes: ONU/OLT identity, software, UNIs, bridge, VLAN, GEM/T-CONT
# path, QoS, multicast, IP host, TR-069. VoIP/SIP MEs are left out (they
# carry credentials).
CLASSES="2 5 6 7 11 45 47 49 79 84 130 131 134 171 256 257 262 263 264 266 268 272 277 278 280 281 309 310 311 329 340"

mark() { printf '\n### %s\n' "$*"; }

{
	mark date;          date; cat /proc/uptime
	mark onu-state;     diag rt_gpon get onu-state
	mark transceiver
	for k in rx-power tx-power temperature; do diag pon get transceiver $k; done
	for c in $CLASSES; do
		mark "mib $c"; omcicli mib get $c
		sleep 1
	done
	mark dump srvflow;  omcicli dump srvflow; sleep 1
	mark dump qmap;     omcicli dump qmap; sleep 2
	mark dump conn;     omcicli dump conn; sleep 1
	for k in 0 1 3 4 5 6 7 8 9 10 11 12 13 14 15; do
		mark "dump avltree $k"; omcicli dump avltree $k; sleep 1
	done
	mark rt_gpon tcont;   diag rt_gpon show tcont
	mark rt_gpon us-flow; diag rt_gpon show us-flow
	mark rt_gpon ds-flow; diag rt_gpon show ds-flow
	mark rt_gpon omcc;    diag rt_gpon show omcc
	mark pon counters
	for k in phy plm omci gem; do diag rt_gpon show counter global $k; done
	echo
} 2>&1 | sed -E 's/^([[:space:]]*[A-Za-z0-9_ ]*([Pp]ass|[Pp]wd|[Uu]ser|[Rr]ealm|[Ll]oid|LOID|[Ss]ecret)[A-Za-z0-9_ ]*[:=]).*/\1 <masked>/' \
	> /tmp/omci-baseline.txt
wc -l /tmp/omci-baseline.txt
