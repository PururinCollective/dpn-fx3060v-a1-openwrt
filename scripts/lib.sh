# shellcheck shell=bash
# Shared helpers for the NijikaWrt build scripts.

TOPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DL_DIR="${DL_DIR:-$TOPDIR/dl}"
BUILD_DIR="${BUILD_DIR:-$TOPDIR/build}"
BIN_DIR="${BIN_DIR:-$TOPDIR/bin}"

# shellcheck source=../build.conf
. "$TOPDIR/build.conf"

# Device profile (devices/<DEVICE>/device.conf)
DEVICE_DIR="$TOPDIR/devices/$DEVICE"
if [ ! -f "$DEVICE_DIR/device.conf" ]; then
	echo "[nijika] unknown DEVICE '$DEVICE' (no $DEVICE_DIR/device.conf)" >&2
	exit 1
fi
# shellcheck source=../devices/dpn-fx3060v-a1/device.conf
. "$DEVICE_DIR/device.conf"
DEVICE_TAG="$(echo "$DEVICE_BOARD" | tr ',' '_')"	# dlink_dpn-fx3060v-a1
: "${ROOTFS_MAX_BYTES:=$DEVICE_ROOTFS_MAX}"

IB_NAME="openwrt-imagebuilder-${OPENWRT_VERSION}-${OPENWRT_TARGET}-${OPENWRT_SUBTARGET}.Linux-x86_64"
IB_URL="${OPENWRT_MIRROR}/releases/${OPENWRT_VERSION}/targets/${OPENWRT_TARGET}/${OPENWRT_SUBTARGET}"
IB_DIR="$BUILD_DIR/$IB_NAME"

STOCK_DIR="$BUILD_DIR/stock"          # unpacked stock firmware tar
VENDOR_DIR="$BUILD_DIR/vendor"        # stock rootfs, becomes /rtk
OWRT_ROOT="$BUILD_DIR/openwrt-root"   # rootfs produced by the ImageBuilder
STAGE_DIR="$BUILD_DIR/stage"          # final merged rootfs

c_info=$'\033[1;36m'; c_warn=$'\033[1;33m'; c_err=$'\033[1;31m'; c_off=$'\033[0m'
[ -t 2 ] || { c_info=; c_warn=; c_err=; c_off=; }

log()  { printf '%s[nijika]%s %s\n' "$c_info" "$c_off" "$*" >&2; }
warn() { printf '%s[nijika]%s %s\n' "$c_warn" "$c_off" "$*" >&2; }
die()  { printf '%s[nijika]%s %s\n' "$c_err" "$c_off" "$*" >&2; exit 1; }

need() {
	local t
	for t in "$@"; do
		command -v "$t" >/dev/null 2>&1 || die "missing host tool: $t"
	done
}

nijika_revision() {
	if [ -n "$NIJIKA_REVISION" ]; then
		echo "$NIJIKA_REVISION"
	elif git -C "$TOPDIR" rev-parse --git-dir >/dev/null 2>&1; then
		git -C "$TOPDIR" rev-list --count HEAD 2>/dev/null || echo 0
	else
		echo 0
	fi
}

nijika_githash() {
	git -C "$TOPDIR" rev-parse --short=8 HEAD 2>/dev/null || echo "local"
}
