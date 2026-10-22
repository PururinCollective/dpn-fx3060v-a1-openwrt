#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-only

# Unpack the stock D-Link firmware (a plain tar) and verify its members.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

need tar md5sum

stock_version() { tar -xOf "$1" fwu_ver 2>/dev/null | head -n 1; }

# The stock firmware of this device (stock/ may hold several revisions'):
# STOCK_FW, or the first stock/*.bin whose version matches the profile.
fw="$STOCK_FW"
if [ -z "$fw" ]; then
	for f in "$TOPDIR"/stock/*.bin; do
		[ -f "$f" ] || continue
		if stock_version "$f" | grep -Eq "$DEVICE_STOCK_MATCH"; then fw="$f"; break; fi
	done
fi
[ -n "$fw" ] && [ -f "$fw" ] ||
	die "no stock firmware for the $DEVICE_MODEL (version matching $DEVICE_STOCK_MATCH) in ./stock/; put the D-Link .bin there or set STOCK_FW"

log "stock firmware: $fw"
rm -rf "$STOCK_DIR"
mkdir -p "$STOCK_DIR"
tar -xf "$fw" -C "$STOCK_DIR"

for m in dtb kimage rootfs md5.txt; do
	[ -f "$STOCK_DIR/$m" ] || die "'$m' missing in $fw (not a D-Link stock firmware?)"
done

( cd "$STOCK_DIR" && grep -E ' (dtb|kimage|rootfs)$' md5.txt | md5sum -c --quiet ) ||
	die "md5 mismatch in stock firmware"

[ "$(head -c 4 "$STOCK_DIR/rootfs")" = "hsqs" ] || die "stock rootfs is not squashfs"

ver=$(head -n 1 "$STOCK_DIR/fwu_ver" 2>/dev/null || true)
log "stock version: ${ver:-unknown}"
# the image ships this kernel + device tree: it must be the profile's revision
echo "$ver" | grep -Eq "$DEVICE_STOCK_MATCH" ||
	die "stock firmware '$ver' is not for the $DEVICE_MODEL (expects $DEVICE_STOCK_MATCH)"
# minimum stock version of the profile (AGENTS.md section 10)
sv=$(echo "$ver" | sed -n 's/^[^_]*_\(V[0-9][0-9.]*\).*/\1/p')
[ -z "$DEVICE_STOCK_MIN" ] || { [ -n "$sv" ] && nijika_ver_ge "$sv" "$DEVICE_STOCK_MIN"; } ||
	die "[FAIL] stock firmware '$ver' is older than $DEVICE_STOCK_MIN (minimum for the $DEVICE_MODEL)"
basename "$fw" > "$STOCK_DIR/.source"
