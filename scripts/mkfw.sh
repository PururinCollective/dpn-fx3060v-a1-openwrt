#!/bin/bash
# Pack the two firmware images from the same kernel/dtb/rootfs:
#
#  *-factory.bin     stock D-Link tar (fwu.sh dtb rootfs kimage fwu_ver hw_ver
#                    md5.txt), for the stock web GUI "Upgrade Firmware" page.
#  *-sysupgrade.bin  OpenWrt NAND sysupgrade tar
#                    (sysupgrade-<board>/{CONTROL,kernel,root,dtb}) with fwtool
#                    metadata, for sysupgrade / LuCI on NijikaWrt.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

need tar md5sum sha256sum

[ -f "$BUILD_DIR/rootfs.squashfs" ] || die "run: ./build.sh assemble"
[ -d "$IB_DIR" ] || die "ImageBuilder missing, run: ./build.sh fetch"

BOARD=dlink_dpn-fx3060v-a1
FWTOOL="$IB_DIR/staging_dir/host/bin/fwtool"
rev="r$(nijika_revision)"
name="${NIJIKA_DISTRO}-${rev}-${OPENWRT_VERSION}-${BOARD}"
version="${rev}_${OPENWRT_VERSION}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$TOPDIR" log -1 --format=%ct 2>/dev/null || date +%s)}"
export SOURCE_DATE_EPOCH

mkdir -p "$BIN_DIR"
rm -f "$BIN_DIR/$name"-*.bin "$BIN_DIR/sha256sums"

# --- factory (stock web GUI) -------------------------------------------------
work="$BUILD_DIR/fw-factory"
rm -rf "$work"
mkdir -p "$work"
cp "$TOPDIR/firmware/fwu.sh" "$work/fwu.sh"
cp "$STOCK_DIR/dtb" "$work/dtb"
cp "$STOCK_DIR/kimage" "$work/kimage"
cp "$BUILD_DIR/rootfs.squashfs" "$work/rootfs"
echo "${NIJIKA_DISTRO}_${version}" > "$work/fwu_ver"
echo "skip" > "$work/hw_ver"
chmod 0755 "$work/fwu.sh"
( cd "$work" && md5sum dtb rootfs kimage fwu_ver hw_ver fwu.sh > md5.txt )

factory="$BIN_DIR/$name-factory.bin"
tar --format=gnu --owner=0 --group=0 --numeric-owner --mtime="@$SOURCE_DATE_EPOCH" \
	-C "$work" -cf "$factory" fwu.sh dtb rootfs kimage fwu_ver hw_ver md5.txt
log "factory:    $factory ($(stat -c %s "$factory") bytes)"

# --- sysupgrade (OpenWrt) ----------------------------------------------------
sysupgrade="$BIN_DIR/$name-sysupgrade.bin"
TOPDIR="$IB_DIR" sh "$IB_DIR/scripts/sysupgrade-tar.sh" \
	--board "$BOARD" \
	--kernel "$STOCK_DIR/kimage" \
	--rootfs "$BUILD_DIR/rootfs.squashfs" \
	--dtb "$STOCK_DIR/dtb" \
	"$sysupgrade" > "$BUILD_DIR/sysupgrade-tar.log" 2>&1 ||
	die "sysupgrade-tar.sh failed, see $BUILD_DIR/sysupgrade-tar.log"

cat > "$BUILD_DIR/metadata.json" <<EOF
{
	"metadata_version": "1.1",
	"compat_version": "1.0",
	"supported_devices": [ "dlink,dpn-fx3060v-a1" ],
	"version": {
		"dist": "$NIJIKA_DISTRO",
		"version": "$version",
		"revision": "$(nijika_githash)",
		"target": "$OPENWRT_TARGET/$OPENWRT_SUBTARGET",
		"board": "$BOARD"
	}
}
EOF
"$FWTOOL" -I "$BUILD_DIR/metadata.json" "$sysupgrade"
"$FWTOOL" -q -i /dev/null "$sysupgrade" || die "metadata check failed on $sysupgrade"
log "sysupgrade: $sysupgrade ($(stat -c %s "$sysupgrade") bytes)"

( cd "$BIN_DIR" && sha256sum "$(basename "$factory")" "$(basename "$sysupgrade")" > sha256sums )
