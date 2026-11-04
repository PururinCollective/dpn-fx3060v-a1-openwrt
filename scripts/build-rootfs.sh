#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-only

# Build the OpenWrt userland with the ImageBuilder and unpack it to
# $OWRT_ROOT. The NijikaWrt packages under package/*/files are injected as
# the ImageBuilder FILES overlay.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

[ -d "$IB_DIR" ] || die "ImageBuilder missing, run: ./build.sh fetch"

overlay="$BUILD_DIR/files"
rm -rf "$overlay"
mkdir -p "$overlay"

# Merge every package payload (package/<name>/files and luci htdocs/root).
for pkg in "$TOPDIR"/package/*/; do
	name=$(basename "$pkg")
	for sub in files root; do
		if [ -d "$pkg/$sub" ]; then
			log "overlay: $name/$sub"
			cp -a "$pkg/$sub/." "$overlay/"
		fi
	done
	if [ -d "$pkg/htdocs" ]; then
		log "overlay: $name/htdocs -> /www"
		mkdir -p "$overlay/www"
		cp -a "$pkg/htdocs/." "$overlay/www/"
	fi
	# luci.mk installs ucode/ as /usr/share/ucode/luci
	if [ -d "$pkg/ucode" ]; then
		log "overlay: $name/ucode -> /usr/share/ucode/luci"
		mkdir -p "$overlay/usr/share/ucode/luci"
		cp -a "$pkg/ucode/." "$overlay/usr/share/ucode/luci/"
	fi
done

# Footstrap (luci-theme-footstrap, the default theme): the two steps of its
# Build/Prepare the image needs. build-css.sh writes the stylesheet from
# styles/ (cat and awk only). The version shown on System > Footstrap comes
# from build.conf: a vendored copy has no git tag.
fs_css="$overlay/www/luci-static/footstrap/cascade.css"
fs_ver="$overlay/www/luci-static/resources/fs-version.js"
sh "$TOPDIR/package/luci-theme-footstrap/build-css.sh" "$fs_css" >/dev/null
[ -s "$fs_css" ] || die "Footstrap: no cascade.css"
sed -i "s#const FS_VERSION *= *'[^']*'#const FS_VERSION = '$FOOTSTRAP_VERSION'#" "$fs_ver"
grep -q "FS_VERSION = '$FOOTSTRAP_VERSION'" "$fs_ver" || die "Footstrap: version not stamped in fs-version.js"
log "Footstrap $FOOTSTRAP_VERSION: cascade.css $(stat -c %s "$fs_css") bytes"

# Files for the vendor chroot (/rtk) are applied by assemble.sh after the
# stock rootfs is unpacked, not by the ImageBuilder.
rm -rf "$BUILD_DIR/files-rtk"
if [ -d "$overlay/rtk" ]; then
	mv "$overlay/rtk" "$BUILD_DIR/files-rtk"
fi

# Release information baked into the image.
rev=$(nijika_revision)
mkdir -p "$overlay/etc"
cat > "$overlay/etc/nijika_release" <<EOF
NIJIKA_DISTRO='$NIJIKA_DISTRO'
NIJIKA_CODENAME='$NIJIKA_CODENAME'
NIJIKA_REVISION='r$rev'
NIJIKA_GITHASH='$(nijika_githash)'
NIJIKA_TAGLINE='$NIJIKA_TAGLINE'
NIJIKA_OPENWRT='$OPENWRT_VERSION'
NIJIKA_BUILD_DATE='$(date -u +%Y-%m-%dT%H:%M:%SZ)'
NIJIKA_DEVICE='$DEVICE_ID'
NIJIKA_BOARD='$DEVICE_BOARD'
NIJIKA_MODEL='$DEVICE_MODEL'
NIJIKA_MODEL_SHORT='${DEVICE_MODEL_SHORT:-$DEVICE_MODEL}'
NIJIKA_STOCK_MATCH='$DEVICE_STOCK_MATCH'
NIJIKA_STOCK_MIN='$DEVICE_STOCK_MIN'
NIJIKA_PHY_IDS='$DEVICE_PHY_IDS'
NIJIKA_KERNEL_MAX='$DEVICE_KERNEL_MAX'
NIJIKA_ROOTFS_MAX='$DEVICE_ROOTFS_MAX'
EOF

# Compute the package list: armsr defaults minus kmods/removed, plus ours.
ib_info=$(make -s -C "$IB_DIR" info)
defaults=$(sed -n 's/^Default Packages: //p' <<<"$ib_info")
profile_pkgs=$(awk '/^generic:/{f=1;next} f && /Packages:/{sub(/.*Packages: /,""); print; exit}' <<<"$ib_info")

pkgs=""
for p in $defaults $profile_pkgs; do
	case "$p" in kmod-*) pkgs="$pkgs -$p"; continue ;; esac
	for r in $OPENWRT_PKGS_REMOVE; do
		[ "$p" = "$r" ] && { pkgs="$pkgs -$p"; continue 2; }
	done
done
for p in $OPENWRT_PKGS_ADD; do pkgs="$pkgs $p"; done
log "packages:$pkgs"

rm -rf "$BUILD_DIR/ib-out"
make -C "$IB_DIR" image \
	PROFILE=generic \
	PACKAGES="$pkgs" \
	FILES="$overlay" \
	EXTRA_IMAGE_NAME=nijika \
	BIN_DIR="$BUILD_DIR/ib-out"

tgz=$(ls "$BUILD_DIR"/ib-out/*nijika*rootfs.tar.gz 2>/dev/null | head -1)
[ -n "$tgz" ] || die "ImageBuilder did not produce a rootfs.tar.gz"

cp "$tgz" "$BUILD_DIR/openwrt-rootfs.tar.gz"
cp "$BUILD_DIR"/ib-out/*.manifest "$BUILD_DIR/openwrt.manifest" 2>/dev/null || true
log "OpenWrt rootfs ready: $BUILD_DIR/openwrt-rootfs.tar.gz"
