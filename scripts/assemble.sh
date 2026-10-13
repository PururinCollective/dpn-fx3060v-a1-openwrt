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

# --- OpenWrt side fix-ups ----------------------------------------------------
R="$STAGE_DIR"

# Stock tool wrappers in PATH.
for t in mib flash diag omcicli nv voipflashcmd smuxctl spppctl; do
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
rm -f "$R"/etc/board.d/*
# Only the stock 5.10.70 kernel runs here.
rm -rf "$R"/lib/modules/[0-9]*

# Login banner: NijikaWrt renderer instead of `cat /etc/banner`.
sed -i 's|^\[ -f /etc/banner \] && cat /etc/banner$|if [ -x /usr/libexec/nijika/banner ] \&\& [ -z "$FAILSAFE" ]; then /usr/libexec/nijika/banner; elif [ -f /etc/banner ]; then cat /etc/banner; fi|' \
	"$R/etc/profile"
grep -q /usr/libexec/nijika/banner "$R/etc/profile" || warn "could not hook the banner into /etc/profile"

# Plain banner for failsafe / dropbear.
. "$R/etc/nijika_release"
. "$R/etc/openwrt_release"
release="$NIJIKA_DISTRO $NIJIKA_REVISION${NIJIKA_CODENAME:+ ($NIJIKA_CODENAME)}"
cat > "$R/etc/banner" <<EOF
                 _______ __ __ __ __           ________        __
                |    |  |__|__|__|  |--.---.-.|  |  |  |.----.|  |_
                |       |  |  |  |    <|  _  ||  |  |  ||   _||   _|
                |__|____|__|  |__|__|__|___._||________||__|  |____|
                           |___|     $NIJIKA_TAGLINE
 -------------------------------------------------------------------------
  $release  |  OpenWrt $DISTRIB_RELEASE $DISTRIB_REVISION
 -------------------------------------------------------------------------
EOF

# LuCI "Firmware Version" shows DISTRIB_DESCRIPTION.
sed -i "s|^DISTRIB_DESCRIPTION=.*|DISTRIB_DESCRIPTION='$release / OpenWrt $DISTRIB_RELEASE $DISTRIB_REVISION'|" \
	"$R/etc/openwrt_release"

# Executable bits for everything we ship (git may not keep them).
chmod 0755 "$R"/usr/sbin/nijika "$R"/usr/libexec/rtk/* "$R"/usr/libexec/rtk/post-boot.d/* \
	"$R"/usr/libexec/nijika/* "$R"/usr/libexec/rpcd/nijika "$R"/etc/init.d/rtk-vendor \
	"$R"/etc/init.d/nijika-ontd "$R"/etc/uci-defaults/90-nijika-defaults "$R"/rtk/bin/boa "$R"/rtk/etc/nijika/rcS 2>/dev/null || true
chmod 0755 "$R/rtk/var" "$R/rtk/run" "$R/rtk/proc" "$R/rtk/sys" "$R/rtk/dev"

# Enable our services (IB only enables packages it installed itself).
for svc in rtk-vendor nijika-ontd; do
	start=$(sed -n 's/^START=//p' "$R/etc/init.d/$svc")
	ln -sf "../init.d/$svc" "$R/etc/rc.d/S${start}$svc"
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
