#!/bin/bash
# NijikaWrt build for the D-Link DPN-FX3060V (A1)
#
#   ./build.sh            # everything: fetch stock kmod rootfs assemble firmware
#   ./build.sh <step>...  # single steps
#   ./build.sh clean      # remove build/ and bin/ (keeps downloads)
#
# Requirements: bash curl tar zstd xz make fakeroot squashfs-tools (4.4+)
# and the stock firmware .bin in ./stock/ (see stock/README.md).
set -euo pipefail
cd "$(dirname "$0")"
. scripts/lib.sh

steps="${*:-all}"
for step in $steps; do
	case "$step" in
		all) "$0" fetch stock kmod rootfs assemble firmware ;;
		fetch) scripts/fetch-imagebuilder.sh ;;
		stock) scripts/extract-stock.sh ;;
		kmod) scripts/build-kmod.sh ;;
		rootfs) scripts/build-rootfs.sh ;;
		assemble) scripts/assemble.sh ;;
		firmware) scripts/mkfw.sh ;;
		clean) rm -rf "$BUILD_DIR" "$BIN_DIR" ;;
		distclean) rm -rf "$BUILD_DIR" "$BIN_DIR" "$DL_DIR" ;;
		*) die "unknown step '$step' (all fetch stock kmod rootfs assemble firmware clean distclean)" ;;
	esac
done
