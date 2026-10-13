#!/bin/sh
# NijikaWrt device probe -- READ ONLY.
#
# Collects the output formats NijikaWrt parses (diag, omcicli, flash chains,
# voipflashcmd, nv) plus layout details (mtd/UBI, mounts, processes,
# firewall) from a DPN-FX3060V running stock firmware or NijikaWrt.
# Nothing is written to flash, nv or the MIB.
#
# Usage on the router (telnet/serial shell, after `sh` on stock):
#   sh probe.sh                 # secrets redacted (default)
#   sh probe.sh --no-redact     # keep passwords/keys (do not share!)
# Output: /tmp/nijika-probe.txt  (also printed to the console)
#
# Getting it onto the router: paste it with `cat > /tmp/probe.sh`, or
#   tftp -g -r probe.sh -l /tmp/probe.sh <pc-ip>

OUT=/tmp/nijika-probe.txt
REDACT=1
[ "$1" = "--no-redact" ] && REDACT=0

# Mask values of keys that look like secrets: KEY=value and "key: value".
redact() {
	if [ "$REDACT" = 1 ]; then
		sed -e 's/^\([^=]*\([Pp][Aa][Ss][Ss]\|[Pp][Ss][Kk]\|[Kk][Ee][Yy]\|[Ss][Ee][Cc][Rr][Ee][Tt]\)[^=]*\)=.*/\1=***REDACTED***/' \
		    -e 's/^\(password\|login_id\): .*/\1: ***REDACTED***/'
	else
		cat
	fi
}

run() {
	echo "===== $* ====="
	sh -c "$*" 2>&1 | redact
	echo
}

{
	echo "NijikaWrt probe $(date) redact=$REDACT"
	echo

	run "cat /proc/version"
	run "cat /proc/cmdline"
	run "cat /etc/version /etc/openwrt_release /etc/nijika_release 2>/dev/null"
	run "cat /proc/mtd"
	run "cat /proc/mounts"
	run "ubinfo -a 2>/dev/null || for d in /sys/class/ubi/ubi0_*; do echo \$d \$(cat \$d/name) \$(cat \$d/data_bytes); done"
	run "cat /sys/class/ubi/ubi0/avail_eraseblocks /sys/class/ubi/ubi0/eraseblock_size"
	run "hexdump -C -n 64 /dev/mtd1 2>/dev/null"
	run "nv getenv"

	run "diag gpon get onu-state"
	run "diag pon get transceiver rx-power"
	run "diag pon get transceiver tx-power"
	run "diag pon get transceiver temperature"
	run "diag pon get transceiver voltage"
	run "diag pon get transceiver bias-current"
	run "diag gpon get alarm-status"
	run "diag gpon show onu-info"
	run "diag gpon show us-flow"
	run "diag gpon show ds-flow"

	for me in 2 7 131 256 257 263 264 11 329 84 171 47 130 268 262; do
		run "omcicli mib get $me"
	done

	run "flash get ATM_VC_TBL"
	run "flash get ATM_VC_TBL.0.vid"
	run "flash get ATM_VC_TBL.0.pppUser"
	run "flash get WLAN_MBSSIB_TBL.0.ssid"
	run "flash get WLAN1_MBSSIB_TBL.0.ssid"
	run "flash get SSID WLAN1_SSID WLAN_PHY_BAND_SELECT WLAN1_PHY_BAND_SELECT"
	run "flash get_def PON_VENDOR_ID GPON_ONU_MODEL OMCI_OLT_MODE OMCI_CUSTOM_BDP OMCI_CUSTOM_RDP OMCI_CUSTOM_ME"
	for f in enable display_name number login_id password addr port domain_name; do
		run "voipflashcmd get $f 0 0"
	done

	run "ps w"
	run "for p in \$(pidof boa boa.stock 2>/dev/null); do echo pid \$p: \$(tr '\\0' ' ' < /proc/\$p/cmdline); done; cat /var/run/boa.pid /rtk/var/run/boa.pid 2>/dev/null"
	run "cat /proc/sys/kernel/hotplug /proc/sys/kernel/modprobe"
	run "ls -la /dev/watchdog* /var/run /var/config /rtk/var/run 2>/dev/null"
	run "lsmod"
	run "iptables -S INPUT; iptables -t nat -S | head -40"
	run "ifconfig -a"
	run "brctl show"
	run "iwconfig 2>/dev/null; iw dev 2>/dev/null"
	run "cat /var/resolv.conf /etc/resolv.conf 2>/dev/null"
	run "logread 2>/dev/null | grep -E 'rtk|nijika' | tail -n 80"
} > "$OUT" 2>&1

cat "$OUT"
echo
echo "Saved to $OUT ($(wc -c < "$OUT") bytes)."
[ "$REDACT" = 1 ] && echo "Secrets were redacted; still review before sharing."
