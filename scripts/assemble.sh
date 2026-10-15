#!/bin/bash
# Merge the OpenWrt userland with the stock Realtek userland (/rtk) and
# produce the squashfs rootfs. Runs entirely inside one fakeroot session so
# ownership and device nodes stay consistent.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

if [ -z "${FAKEROOTKEY:-}" ]; then
	need fakeroot
	exec fakeroot -- "$0" "$@"
fi

need tar unsquashfs mksquashfs

[ -f "$BUILD_DIR/openwrt-rootfs.tar.gz" ] || die "run: ./build.sh rootfs"
[ -f "$STOCK_DIR/rootfs" ] || die "run: ./build.sh stock"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

log "unpacking OpenWrt rootfs"
tar -xzpf "$BUILD_DIR/openwrt-rootfs.tar.gz" -C "$STAGE_DIR"

log "unpacking stock rootfs to /rtk"
unsquashfs -q -n -d "$STAGE_DIR/rtk" "$STOCK_DIR/rootfs" >/dev/null
"$TOPDIR/scripts/patch-vendor.sh" "$STAGE_DIR/rtk"

if [ -d "$BUILD_DIR/files-rtk" ]; then
	log "applying NijikaWrt files to /rtk"
	cp -a "$BUILD_DIR/files-rtk/." "$STAGE_DIR/rtk/"
fi

# Native helpers (rtk-apply against the stock libraries just unpacked,
# logrelay for the OpenWrt side)
"$TOPDIR/scripts/build-helpers.sh" "$STAGE_DIR"

# --- OpenWrt side fix-ups ----------------------------------------------------
R="$STAGE_DIR"

# Stock tool wrappers in PATH.
for t in mib flash diag omcicli nv voipflashcmd smuxctl spppctl iptables ip6tables ebtables; do
	ln -sf ../libexec/rtk/wrap "$R/usr/bin/$t"
done
ln -sf ../libexec/rtk/run "$R/usr/sbin/rtk"

# Paths the stock kernel/drivers open themselves (firmware loader, serdes
# tables, scfg) resolve against the host root, not the chroot: mirror them.
for p in lib/firmware etc/serdes etc/conf; do
	[ -e "$R/rtk/$p" ] || continue
	if [ -d "$R/$p" ] && [ ! -L "$R/$p" ]; then
		rmdir "$R/$p" 2>/dev/null || { warn "/$p exists in OpenWrt rootfs, not mirrored"; continue; }
	fi
	ln -sfn "/rtk/$p" "$R/$p"
done
ln -sfn /rtk/var/config "$R/config"

# armsr leftovers that assume an EFI disk / ACPI machine.
rm -f "$R/lib/preinit/01_sysinfo_acpi" "$R/lib/preinit/79_move_config"
for f in "$R"/etc/board.d/*; do
	case "${f##*/}" in *nijika*) ;; *) rm -f "$f" ;; esac
done
# Only the stock 5.10.70 kernel runs here.
rm -rf "$R"/lib/modules/[0-9]*
# The opkg -> apk cheat sheet printed at every login (base-files).
rm -f "$R/etc/profile.d/apk-cheatsheet.sh"
# https-dns-proxy runs from nijika-doh; the package's own service is built
# around OpenWrt's dnsmasq and nftables, which this image does not have.
rm -f "$R/etc/init.d/https-dns-proxy" "$R"/etc/rc.d/[SK]*https-dns-proxy \
	"$R/etc/config/https-dns-proxy" "$R/etc/uci-defaults/50-https-dns-proxy-migrate-options.sh"

# Login banner: NijikaWrt renderer instead of `cat /etc/banner`.
sed -i 's|^\[ -f /etc/banner \] && cat /etc/banner$|if [ -x /usr/libexec/nijika/banner ] \&\& [ -z "$FAILSAFE" ]; then /usr/libexec/nijika/banner; elif [ -f /etc/banner ]; then cat /etc/banner; fi|' \
	"$R/etc/profile"
grep -q /usr/libexec/nijika/banner "$R/etc/profile" || warn "could not hook the banner into /etc/profile"

# Plain banner for failsafe / dropbear: the login banner's layout
# (banner-layout.sh) without colour, animation or the live PON line.
. "$R/etc/nijika_release"
. "$R/etc/openwrt_release"
release="$NIJIKA_DISTRO $NIJIKA_REVISION${NIJIKA_CODENAME:+ ($NIJIKA_CODENAME)}"
(
	owrt="OpenWrt $DISTRIB_RELEASE $DISTRIB_REVISION"
	kernel="$(cd "$R/rtk/lib/modules" 2>/dev/null && ls -d [0-9]* | head -n 1)"	# the stock kernel
	tagline="$NIJIKA_TAGLINE"
	model="${NIJIKA_MODEL_SHORT:-$NIJIKA_MODEL}"
	status_line=""
	. "$R/usr/lib/nijika/banner-layout.sh"
	banner_layout "$R/usr/share/nijika/banner-links" | banner_plain
) > "$R/etc/banner"

# LuCI "Firmware Version" shows DISTRIB_DESCRIPTION.
sed -i "s|^DISTRIB_DESCRIPTION=.*|DISTRIB_DESCRIPTION='$release / OpenWrt $DISTRIB_RELEASE $DISTRIB_REVISION'|" \
	"$R/etc/openwrt_release"

# Executable bits for everything we ship (git may not keep them).
chmod 0755 "$R"/usr/sbin/nijika "$R"/usr/libexec/rtk/* "$R"/usr/libexec/rtk/post-boot.d/* \
	"$R"/usr/libexec/nijika/* "$R"/usr/libexec/rpcd/nijika "$R"/etc/init.d/rtk-vendor \
	"$R"/etc/init.d/nijika-housekeep "$R"/etc/init.d/nijika-doh "$R"/etc/uci-defaults/90-nijika-defaults \
	"$R"/rtk/bin/ccom_linkkit "$R"/rtk/bin/dnsmasq "$R"/rtk/bin/slogd "$R"/rtk/etc/nijika/rcS 2>/dev/null || true
chmod 0755 "$R/rtk/var" "$R/rtk/run" "$R/rtk/proc" "$R/rtk/sys" "$R/rtk/dev"

# Enable our services (IB only enables packages it installed itself).
for svc in rtk-vendor nijika-housekeep nijika-doh; do
	start=$(sed -n 's/^START=//p' "$R/etc/init.d/$svc")
	stop=$(sed -n 's/^STOP=//p' "$R/etc/init.d/$svc")
	ln -sf "../init.d/$svc" "$R/etc/rc.d/S${start}$svc"
	[ -z "$stop" ] || ln -sf "../init.d/$svc" "$R/etc/rc.d/K${stop}$svc"
done

# --- squashfs --------------------------------------------------------------
out="$BUILD_DIR/rootfs.squashfs"
rm -f "$out"
log "creating squashfs"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$TOPDIR" log -1 --format=%ct 2>/dev/null || date +%s)}"
mksquashfs "$STAGE_DIR" "$out" -comp xz -b "$SQUASHFS_BLOCK" -noappend -no-xattrs \
	-mkfs-time "$SOURCE_DATE_EPOCH" -all-time "$SOURCE_DATE_EPOCH" -quiet >/dev/null

size=$(stat -c %s "$out")
log "rootfs: $size bytes (limit $ROOTFS_MAX_BYTES)"
[ "$size" -le "$ROOTFS_MAX_BYTES" ] || die "rootfs does not fit ubi_r0/ubi_r1"
