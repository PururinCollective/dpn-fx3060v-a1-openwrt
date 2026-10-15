#!/bin/sh
# NijikaWrt factory installer for the D-Link DPN-FX3060V.
#
# Runs on the STOCK firmware: the stock web upgrade (configd ->
# /etc/scripts/fwu_starter.sh) extracts this file from the uploaded image,
# checks it against md5.txt and runs
#     sh fwu.sh <bank 0|1> <image.tar> [lowmem]
# Writes dtb/kimage/rootfs into ubi_DTB<bank>/ubi_k<bank>/ubi_r<bank>,
# records sw_version<bank>; configd then sets sw_tryactive and reboots.
#
# Every check runs before anything is written. Log tags:
#   [~] in progress   [+] ok / found   [-] skipped / not applicable
#   [!] warning       [x] failed       [?] unknown
#
# The image carries the stock kernel and device tree of ONE hardware revision:
# the device block below (filled in by scripts/mkfw.sh from
# devices/<id>/device.conf) names it, and the installer refuses a stock
# firmware or hardware (switch PHY IDs) of another revision.
# Force anyway (at your own risk):
#     touch /tmp/nijika_force

bank="$1"
img="$2"

# Device paths, overridable for tools/fwu-dryrun.sh
SYS_UBI=${NIJIKA_SYS_UBI:-/sys/class/ubi}
CMDLINE=${NIJIKA_CMDLINE:-/proc/cmdline}
VERSION_FILE=${NIJIKA_VERSION_FILE:-/etc/version}
STATUS_FILE=${NIJIKA_STATUS_FILE:-/var/firmware_upgrade_status}
CONSOLE=${NIJIKA_CONSOLE:-/dev/console}
MNT=${NIJIKA_MNT:-/tmp/nijika_data}
FORCE_FILE=${NIJIKA_FORCE_FILE:-/tmp/nijika_force}

# Stock /var/firmware_upgrade_status codes (see stock fwu.sh)
ST_INVALID=1
ST_TOO_BIG=3

# Device profile (IMG_DEVICE, IMG_MODEL, IMG_STOCK_MATCH, IMG_PHY_IDS,
# KERNEL_MAX), filled in by scripts/mkfw.sh
# @DEVICE@

# PHY ID (page 0, registers 2+3) of switch ports 0..6, as in device.conf:
# "001ccac4 001ccac4 ... ffffffff". Empty when diag cannot tell.
# Runs under the stock busybox 1.22 ash: it has no `command` builtin, `type` works.
phy_ids() {
	type diag >/dev/null 2>&1 || return 0
	local p r out=""
	for p in 0 1 2 3 4 5 6; do
		r=$(for reg in 2 3; do diag rt_port get phy-reg port $p page 0 register $reg 2>/dev/null; done |
			sed -n 's/.*Register [23]: 0x\([0-9A-Fa-f][0-9A-Fa-f]*\).*/\1/p' | tr -d '\n' | tr 'A-F' 'a-f')
		[ ${#r} -eq 8 ] || return 0
		out="$out${out:+ }$r"
	done
	echo "$out"
}

# --- logging -----------------------------------------------------------------

# configd usually runs us with stdout on the serial console already; mirror
# to /dev/console only when it does not, so lines never appear twice.
mirror=1
case "$(readlink /proc/$$/fd/1 2>/dev/null)" in
	/dev/console|/dev/tty*) mirror=0 ;;
esac

say() { # <tag> <message>
	echo "[$1] $2"
	[ "$mirror" = 1 ] && echo "[$1] $2" > "$CONSOLE" 2>/dev/null
	return 0
}
step()    { say "~" "$*"; }
ok()      { say "+" "$*"; }
skip()    { say "-" "$*"; }
warn()    { say "!" "$*"; }
unknown() { say "?" "$*"; }

written=0

cleanup() {
	rm -f dtb kimage rootfs fwu_ver md5.txt
}

fail() { # <status code> <message>
	say "x" "$2"
	if [ "$written" = 1 ]; then
		say "x" "bank $bank is incomplete and will not boot; the running firmware is untouched"
	else
		say "x" "nothing was written, stock firmware unchanged"
	fi
	echo "$1" > "$STATUS_FILE" 2>/dev/null
	cleanup
	exit 1
}

# /dev/ubi0_N of the volume called <name>
vol_dev() {
	local d
	for d in "$SYS_UBI"/ubi0_*; do
		[ "$(cat "$d/name" 2>/dev/null)" = "$1" ] && { echo "/dev/${d##*/}"; return 0; }
	done
	return 1
}

vol_bytes() {
	cat "$SYS_UBI/${1#/dev/}/data_bytes" 2>/dev/null
}

say "~" "NijikaWrt factory installer"

# --- arguments -----------------------------------------------------------------

case "$bank" in
	0|1) ok "target bank: $bank" ;;
	*) fail $ST_INVALID "invalid target bank '$bank'" ;;
esac
[ -f "$img" ] || fail $ST_INVALID "image $img not found"
ok "image: $img ($(wc -c < "$img") bytes)"

# --- the right device and hardware revision? ---------------------------------

[ -n "$IMG_DEVICE" ] || fail $ST_INVALID "fwu.sh has no device profile (not built by scripts/mkfw.sh)"
ok "image for: $IMG_MODEL"

stock_ver=$(cat "$VERSION_FILE" 2>/dev/null)
if echo "$stock_ver" | grep -Eq "$IMG_STOCK_MATCH"; then
	ok "running firmware: $stock_ver"
elif [ -f "$FORCE_FILE" ]; then
	warn "running firmware '$stock_ver' is not the stock firmware of $IMG_MODEL, continuing: $FORCE_FILE"
else
	fail $ST_INVALID "this image is for $IMG_MODEL, the running firmware is '$stock_ver'; touch $FORCE_FILE to override"
fi

phy=$(phy_ids)
if [ -z "$phy" ]; then
	unknown "switch PHY IDs not readable, hardware revision not verified"
elif [ "$phy" = "$IMG_PHY_IDS" ]; then
	ok "hardware matches $IMG_MODEL (switch PHY IDs)"
elif [ -f "$FORCE_FILE" ]; then
	warn "hardware differs from $IMG_MODEL (PHY IDs $phy), continuing: $FORCE_FILE"
else
	fail $ST_INVALID "this image is for $IMG_MODEL, but this hardware differs (PHY IDs $phy); touch $FORCE_FILE to override"
fi

# --- never write the bank we are running from -----------------------------------
# configd picks the bank as 1 - sw_active. If the U-Boot environment does not
# match the running bank (a bank booted by hand from U-Boot without saveenv),
# it asks us to overwrite the running firmware. Correct the environment and
# let the user upload again, so configd also sets up the trial boot for the
# right bank afterwards.

active=$(nv getenv sw_active 2>/dev/null | sed -n 's/^sw_active=//p')
running=""
case " $(cat "$CMDLINE" 2>/dev/null) " in
	*" root=31:8 "*) running=0 ;;
	*" root=31:11 "*) running=1 ;;
esac

if [ -n "$running" ]; then
	ok "running bank: $running (kernel root=$([ "$running" = 0 ] && echo 31:8 || echo 31:11)), sw_active=${active:-?}"
else
	unknown "running bank not found in $CMDLINE, trusting sw_active=${active:-?}"
	running="$active"
fi

if [ -z "$running" ]; then
	fail $ST_INVALID "cannot determine the running bank (no root= and no sw_active)"
fi

if [ "$bank" = "$running" ]; then
	warn "bank $bank was selected, but the running firmware is in bank $running"
	warn "U-Boot environment out of sync (sw_active=${active:-?})"
	step "correcting the boot environment to bank $running"
	nv setenv sw_active "$running"
	nv setenv sw_commit "$running"
	nv setenv sw_tryactive 2
	rm -f "$img"

	# Read it back: if the write did not stick, another upload would only
	# repeat this, so say exactly what to do instead.
	now_active=$(nv getenv sw_active 2>/dev/null | sed -n 's/^sw_active=//p')
	now_commit=$(nv getenv sw_commit 2>/dev/null | sed -n 's/^sw_commit=//p')
	now_try=$(nv getenv sw_tryactive 2>/dev/null | sed -n 's/^sw_tryactive=//p')
	if [ "$now_active" = "$running" ] && [ "$now_commit" = "$running" ]; then
		ok "boot environment now: sw_active=$now_active sw_commit=$now_commit sw_tryactive=${now_try:-?}"
		fail $ST_INVALID "please upload the firmware again (it will go to bank $((1 - running)))"
	fi
	say "x" "boot environment could not be written (reads sw_active=${now_active:-?} sw_commit=${now_commit:-?})"
	say "x" "fix it from the stock shell (telnet/UART), then upload again:"
	say "x" "    nv setenv sw_active $running; nv setenv sw_commit $running; nv setenv sw_tryactive 2"
	fail $ST_INVALID "upgrade aborted"
fi

if [ -n "$active" ] && [ "$active" != "$running" ]; then
	warn "sw_active=$active does not match running bank $running (bank $bank is still the inactive one)"
fi

# --- image integrity -------------------------------------------------------------

step "verifying image members against md5.txt"
tar -xf "$img" md5.txt 2>/dev/null || fail $ST_INVALID "md5.txt missing in image"
for m in dtb kimage rootfs fwu_ver; do
	want=$(awk -v f="$m" '$2 == f { print $1 }' md5.txt)
	got=$(tar -xOf "$img" "$m" 2>/dev/null | md5sum | cut -d' ' -f1)
	[ -n "$want" ] || fail $ST_INVALID "$m is not listed in md5.txt"
	[ "$want" = "$got" ] || fail $ST_INVALID "$m md5 mismatch (corrupt upload?)"
	ok "$m md5 $got"
done

tar -xf "$img" fwu_ver 2>/dev/null || fail $ST_INVALID "fwu_ver missing in image"
new_ver=$(sed 's/ *--.*$//' fwu_ver | head -n 1)
ok "upgrade: ${stock_ver:-unknown} -> $new_ver"
skip "hw_ver check not used (image hw_ver=$(tar -xOf "$img" hw_ver 2>/dev/null))"

# --- sizes against the target volumes --------------------------------------------

step "checking sizes against bank $bank volumes"
for pair in "dtb:ubi_DTB$bank" "kimage:ubi_k$bank" "rootfs:ubi_r$bank"; do
	m=${pair%%:*}
	v=${pair#*:}
	dev=$(vol_dev "$v") || fail $ST_INVALID "UBI volume $v not found"
	size=$(tar -tvf "$img" "$m" 2>/dev/null | awk '{ print $3; exit }')
	limit=$(vol_bytes "$dev")
	[ "$m" = kimage ] && { [ -z "$limit" ] || [ "$limit" -gt $KERNEL_MAX ]; } && limit=$KERNEL_MAX
	if [ -z "$size" ]; then
		fail $ST_INVALID "cannot read the size of $m"
	elif [ -z "$limit" ]; then
		unknown "$v size unknown, $m is $size bytes"
	elif [ "$size" -gt "$limit" ]; then
		fail $ST_TOO_BIG "$m ($size bytes) does not fit $v ($limit bytes)"
	else
		ok "$m $size bytes fits $v $dev ($limit bytes)"
	fi
done

# --- write -----------------------------------------------------------------------

written=1
for pair in "dtb:ubi_DTB$bank" "kimage:ubi_k$bank" "rootfs:ubi_r$bank"; do
	m=${pair%%:*}
	v=${pair#*:}
	dev=$(vol_dev "$v")
	step "writing $m -> $v ($dev)"
	tar -xf "$img" "$m" || fail $ST_INVALID "cannot extract $m"
	ubiupdatevol "$dev" "$m" || fail $ST_INVALID "writing $v failed"
	rm -f "$m"
	ok "$v written"
done

nv setenv "sw_version$bank" "$new_ver"
ok "sw_version$bank=$new_ver"

# --- OpenWrt overlay ---------------------------------------------------------------
# A factory flash is a fresh install. The overlay (UBI volume rootfs_data,
# shared by both banks) may hold settings of an earlier NijikaWrt; the next
# NijikaWrt boot resets it (preinit, /lib/preinit/75_nijika_rootfs_data).

data=$(vol_dev rootfs_data)
if [ -z "$data" ]; then
	skip "no OpenWrt overlay yet, rootfs_data is created on first boot"
else
	step "marking OpenWrt overlay $data for reset"
	mkdir -p "$MNT"
	if mount -t ubifs ubi0:rootfs_data "$MNT" 2>/dev/null; then
		rm -f "$MNT/.nijika_keep.tgz"
		touch "$MNT/.nijika_wipe"
		sync
		umount "$MNT"
		ok "OpenWrt settings will be reset on first boot (factory install)"
	else
		warn "could not mount rootfs_data; old OpenWrt settings may survive (run firstboot later)"
	fi
	rmdir "$MNT" 2>/dev/null
fi

cleanup
rm -f "$img"
ok "Successfully updated image $bank!!"
step "rebooting into bank $bank as a trial boot (falls back to bank $running on failure)"
exit 0
