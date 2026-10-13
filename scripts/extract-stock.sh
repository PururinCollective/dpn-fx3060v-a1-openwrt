#!/bin/bash
# Unpack the stock D-Link firmware (a plain tar) and verify its members.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

need tar md5sum

fw="$STOCK_FW"
if [ -z "$fw" ]; then
	fw=$(ls "$TOPDIR"/stock/*.bin 2>/dev/null | head -n 1 || true)
fi
[ -n "$fw" ] && [ -f "$fw" ] || die "stock firmware not found: put the D-Link .bin into ./stock/ or set STOCK_FW"

log "stock firmware: $fw"
rm -rf "$STOCK_DIR"
mkdir -p "$STOCK_DIR"
tar -xf "$fw" -C "$STOCK_DIR"

for m in dtb kimage rootfs md5.txt; do
	[ -f "$STOCK_DIR/$m" ] || die "'$m' missing in $fw (not a DPN-FX3060V firmware?)"
done

( cd "$STOCK_DIR" && grep -E ' (dtb|kimage|rootfs)$' md5.txt | md5sum -c --quiet ) ||
	die "md5 mismatch in stock firmware"

[ "$(head -c 4 "$STOCK_DIR/rootfs")" = "hsqs" ] || die "stock rootfs is not squashfs"

log "stock version: $(head -n 1 "$STOCK_DIR/fwu_ver" 2>/dev/null || echo unknown)"
basename "$fw" > "$STOCK_DIR/.source"
