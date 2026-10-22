# SPDX-License-Identifier: GPL-2.0-only

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

# --- Origin and attribution notice (AGENTS.md section 6) ---------------------
# The original repository. A build from any other source (a fork, a copy, an
# archive without git) shows the attribution notice on the LuCI login page and
# on Status > Overview. Do not remove or weaken this check or the notice.
NIJIKA_UPSTREAM="PururinCollective/dpn-fx3060v-a1-openwrt"
NIJIKA_NOTICE_FMT="Nijika Firmware %s, %s, Open PON Foundation (project lead by Anime4000/RTL960x)"
NIJIKA_NOTICE_FILES="usr/share/ucode/luci/template/themes/perfect/sysauth.ut
www/luci-static/resources/view/status/include/11_nijika_notice.js"
NIJIKA_NOTICE_BOOTSTRAP="usr/share/ucode/luci/template/themes/bootstrap/sysauth.ut"

# nijika_origin -> upstream | fork. upstream: the git remote "origin" of this
# checkout is the original repository on GitHub.
nijika_origin() {
	local url
	url=$(git -C "$TOPDIR" remote get-url origin 2>/dev/null) || { echo fork; return 0; }
	if printf '%s\n' "$url" | grep -qiE "^(https://|ssh://git@|git@)github\.com[:/]${NIJIKA_UPSTREAM}(\.git)?/?$"; then
		echo upstream
	else
		echo fork
	fi
}

# nijika_sync_check: before a build the checkout is in sync with its remote
# (AGENTS.md section 9). Fetches origin (15 s, skipped offline) and warns
# when the branch is behind it.
nijika_sync_check() {
	local up behind
	if ! git -C "$TOPDIR" rev-parse --git-dir >/dev/null 2>&1; then
		warn "not a git checkout: sync with github.com/$NIJIKA_UPSTREAM before a build"
		return 0
	fi
	if ! timeout 15 git -C "$TOPDIR" fetch --quiet origin 2>/dev/null; then
		warn "git fetch origin failed (offline?): the checkout is not checked against its remote"
		return 0
	fi
	up=$(git -C "$TOPDIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || {
		warn "the branch has no upstream: sync it with origin before a build"
		return 0
	}
	behind=$(git -C "$TOPDIR" rev-list --count "HEAD..$up" 2>/dev/null || echo 0)
	if [ "$behind" -gt 0 ]; then
		warn "the checkout is $behind commit(s) behind $up: run 'git pull --ff-only' before a build"
	else
		log "checkout in sync with $up"
	fi
}

# nijika_ver_ge A B: version A >= version B ("V1.1.2", "1.1.2")
nijika_ver_ge() {
	awk -v a="${1#[Vv]}" -v b="${2#[Vv]}" 'BEGIN {
		na = split(a, x, "."); nb = split(b, y, ".")
		for (i = 1; i <= (na > nb ? na : nb); i++) {
			if (x[i] + 0 > y[i] + 0) exit 0
			if (x[i] + 0 < y[i] + 0) exit 1
		}
		exit 0 }'
}

# nijika_stock_version -> "V1.1.2" (fwu_ver of the stock firmware:
# "DPN-FX3060V_V1.1.2 -- <date>")
nijika_stock_version() {
	sed -n '1s/^[^_]*_\(V[0-9][0-9.]*\).*/\1/p' "$STOCK_DIR/fwu_ver" 2>/dev/null
}

# nijika_notice_apply ROOT NOTICE: write NOTICE (empty: no notice) into the
# files of NIJIKA_NOTICE_FILES (placeholder @NIJIKA_NOTICE@) and below the
# login form of the Bootstrap theme.
nijika_notice_apply() {
	local root="$1" notice="$2" html js f
	html=$(printf '%s' "$notice" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e "s/'/\&#39;/g" -e 's/"/\&quot;/g')
	js=$(printf '%s' "$notice" | sed -e 's/[\\'"'"']/\\&/g')
	for f in $NIJIKA_NOTICE_FILES; do
		[ -f "$root/$f" ] || die "notice: $f missing"
		grep -q '@NIJIKA_NOTICE@' "$root/$f" || die "notice: no @NIJIKA_NOTICE@ in $f"
		case "$f" in
			*.js) sed -i "s#@NIJIKA_NOTICE@#$(printf '%s' "$js" | sed -e 's/[\\&#]/\\&/g')#g" "$root/$f" ;;
			*) if [ -n "$notice" ]; then
				sed -i "s#@NIJIKA_NOTICE@#$(printf '%s' "$html" | sed -e 's/[\\&#]/\\&/g')#g" "$root/$f"
			   else
				sed -i '/@NIJIKA_NOTICE@/d' "$root/$f"
			   fi ;;
		esac
	done
	f="$root/$NIJIKA_NOTICE_BOOTSTRAP"
	if [ -n "$notice" ] && [ -f "$f" ]; then
		grep -q '</form>' "$f" || die "notice: no </form> in $NIJIKA_NOTICE_BOOTSTRAP"
		sed -i "0,/<\/form>/s#</form>#</form>\n\t<p class=\"nijika-notice\">$(printf '%s' "$html" | sed -e 's/[\\&#]/\\&/g')</p>#" "$f"
	fi
}
