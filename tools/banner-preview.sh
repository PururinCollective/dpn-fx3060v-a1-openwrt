#!/bin/sh
# Preview the NijikaWrt login banner on a PC (needs busybox or any POSIX sh
# + awk). Uses the very same script/renderer that ships in the image.
#
#   tools/banner-preview.sh                 # animated, auto colour
#   COLOR=256 tools/banner-preview.sh       # truecolor|256|16|none
#   STATE=O3 RX=-28.4 TX=2.1 tools/banner-preview.sh
#   STATE=O1.1 LOS=1 RX=-inf TX=-inf tools/banner-preview.sh   # no fibre
#   NODATA=1 tools/banner-preview.sh                         # no PON reading yet
#   ANIMATE=never tools/banner-preview.sh

TOP="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$TOP/package/nijika-base/files"
SH="${SH:-$(command -v busybox >/dev/null && echo 'busybox sh' || echo sh)}"

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

mkdir -p "$root/etc" "$root/tmp/nijika" "$root/usr/lib/nijika" "$root/usr/share/nijika"
cp "$PKG/usr/lib/nijika/banner.awk" "$PKG/usr/lib/nijika/banner-layout.sh" "$root/usr/lib/nijika/"
cp "$PKG/usr/share/nijika/banner-links" "$root/usr/share/nijika/"

cat > "$root/etc/openwrt_release" <<EOF
DISTRIB_RELEASE='${OWRT:-25.12.5}'
DISTRIB_REVISION='${OWRT_REV:-r33051-f5dae5ece4}'
EOF
cat > "$root/etc/nijika_release" <<EOF
NIJIKA_DISTRO='NijikaWrt'
NIJIKA_CODENAME='${CODENAME:-}'
NIJIKA_REVISION='${REV:-r647}'
NIJIKA_TAGLINE='O P E N  P O N  F O U N D A T I O N'
NIJIKA_MODEL='D-Link ${MODEL:-DPN-FX3060V (A1)}'
NIJIKA_MODEL_SHORT='${MODEL:-DPN-FX3060V (A1)}'
EOF
[ -n "$NODATA" ] || cat > "$root/tmp/nijika/pon.env" <<EOF
PON_STATE='${STATE:-O5}'
PON_STATE_TEXT='${STATE_TEXT:-operational}'
PON_LOS='${LOS:-0}'
PON_RX_DBM='${RX--19.7}'
PON_TX_DBM='${TX-3.2}'
PON_UPDATED='$(date +%s)'
EOF
echo "4440.12 1000.00" > "$root/uptime"

NIJIKA_BANNER_FORCE=1 \
NIJIKA_BANNER_ROOT="$root" \
NIJIKA_BANNER_UPTIME="$root/uptime" \
NIJIKA_BANNER_KERNEL="${KERNEL:-5.10.70}" \
NIJIKA_BANNER_ANIMATE="${ANIMATE:-always}" \
NIJIKA_BANNER_COLOR="${COLOR:-auto}" \
NIJIKA_BANNER_SLEEP="${SLEEP:-sleep 0.028}" \
	$SH "$PKG/usr/libexec/nijika/banner"
