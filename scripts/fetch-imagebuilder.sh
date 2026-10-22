#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-only

# Download and unpack the OpenWrt ImageBuilder for armsr/armv8.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

need curl zstd tar sha256sum

archive="$IB_NAME.tar.zst"
mkdir -p "$DL_DIR" "$BUILD_DIR"

if [ ! -f "$DL_DIR/$archive" ]; then
	log "downloading $archive"
	curl -fL --retry 3 -o "$DL_DIR/$archive.part" "$IB_URL/$archive"
	mv "$DL_DIR/$archive.part" "$DL_DIR/$archive"
fi

log "verifying checksum"
curl -fsSL "$IB_URL/sha256sums" -o "$DL_DIR/sha256sums.$OPENWRT_VERSION"
expected=$(awk -v f="*$archive" '$2 == f { print $1 }' "$DL_DIR/sha256sums.$OPENWRT_VERSION")
[ -n "$expected" ] || die "no checksum for $archive in upstream sha256sums"
actual=$(sha256sum "$DL_DIR/$archive" | cut -d' ' -f1)
[ "$expected" = "$actual" ] || die "checksum mismatch for $archive"

if [ ! -d "$IB_DIR" ]; then
	log "unpacking ImageBuilder"
	tar --zstd -xf "$DL_DIR/$archive" -C "$BUILD_DIR"
fi

log "ImageBuilder ready: $IB_DIR"
