#!/bin/bash
# Patch the stock rootfs so it can run as the /rtk chroot under OpenWrt.
# Usage: patch-vendor.sh <path-to-rtk-tree>
#
# Nothing is deleted: rc files are copied to /etc/nijika/rc.d and the lines
# that would fight OpenWrt are commented out there, so the original rc
# chain stays available for comparison.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

RTKDIR="$1"
[ -d "$RTKDIR/etc/init.d" ] || die "not a stock rootfs: $RTKDIR"

# comment_line <file> <fixed string> <reason>
comment_line() {
	local f="$1" pat="$2" why="$3"
	if grep -qF -- "$pat" "$f"; then
		awk -v pat="$pat" -v why="$why" '
			index($0, pat) && $0 !~ /^#/ { print "# [nijika] " why; print "#" $0; next }
			{ print }' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
	else
		warn "patch-vendor: '$pat' not found in ${f##*/} (different stock firmware?)"
	fi
}

mkdir -p "$RTKDIR/etc/nijika/rc.d"
for rc in "$RTKDIR"/etc/init.d/rc[0-9]*; do
	cp -p "$rc" "$RTKDIR/etc/nijika/rc.d/"
done
RC="$RTKDIR/etc/nijika/rc.d"

# rc2: OpenWrt already mounted proc/sys/dev/devpts, gives the chroot its own
# tmpfs /var, owns hotplug (procd) and the root filesystem.
comment_line "$RC/rc2" "/etc/scripts/sysfs.sh" "host mounts /proc /sys /dev /run for the chroot"
comment_line "$RC/rc2" "/etc/scripts/devpts.sh" "devpts is bind mounted from the host"
comment_line "$RC/rc2" "/etc/scripts/checkroot.sh" "never remount the host root"
comment_line "$RC/rc2" "mount -t ramfs ramfs /var" "host mounts a tmpfs on /rtk/var"
comment_line "$RC/rc2" "/proc/sys/kernel/hotplug" "procd handles hotplug"
comment_line "$RC/rc2" "mdev -s" "devtmpfs + procd create device nodes"

# rc34: procd feeds /dev/watchdog (also armed by U-Boot for trial boots).
[ -f "$RC/rc34" ] && comment_line "$RC/rc34" "rtk_watchdog" "procd owns /dev/watchdog"

# boa stays the real stock binary: besides the web GUI it starts the VoIP
# flash server (voip_flash_server_start) that VoIP_maserati waits for. It
# only moves to port 8080 (below); lan-mgmt firewalls it to localhost unless
# nijika.vendor.boa=lan.

# Alibaba Cloud Link Kit agent (iot-*.aliyuncs.com: cloud FOTA/COTA, remote
# property/service calls, AWSS WiFi provisioning, ALCS LAN control). Removed
# from the image; package rtk-vendor installs an inert placeholder with the
# same name because `startup` launches it and libmib kills it by name.
if [ -f "$RTKDIR/bin/ccom_linkkit" ] && ! grep -q "NijikaWrt placeholder" "$RTKDIR/bin/ccom_linkkit" 2>/dev/null; then
	rm -f "$RTKDIR/bin/ccom_linkkit"
	log "removed bin/ccom_linkkit (Alibaba Cloud IoT agent)"
fi

# Stock GUI moves to 8080, uhttpd/LuCI owns port 80.
if [ -f "$RTKDIR/home/httpd/boa.conf" ]; then
	sed -i 's/^Port 80$/Port 8080/' "$RTKDIR/home/httpd/boa.conf"
fi

# Stock inetd must never bind SSH; OpenWrt's dropbear serves port 22.
if [ -f "$RTKDIR/etc/inetd.conf" ]; then
	sed -i 's|^ssh |#ssh |' "$RTKDIR/etc/inetd.conf"
fi

# DNS over HTTPS: the stock dnsmasq runs through a wrapper (rtk/bin/dnsmasq
# from rtk-vendor) that swaps its generic upstreams for the local DoH proxy.
# The real binary keeps its name so pidof/killall dnsmasq still find it.
if [ -f "$RTKDIR/bin/dnsmasq" ] && ! grep -q "NijikaWrt wrapper" "$RTKDIR/bin/dnsmasq" 2>/dev/null; then
	mkdir -p "$RTKDIR/lib/nijika"
	mv "$RTKDIR/bin/dnsmasq" "$RTKDIR/lib/nijika/dnsmasq"
	log "moved bin/dnsmasq to lib/nijika/dnsmasq (DoH wrapper)"
fi

log "vendor tree patched"
