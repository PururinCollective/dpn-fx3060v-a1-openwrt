#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-only

# NijikaWrt build for the D-Link DPN-FX3060V (A1)
#
#   ./build.sh            # everything: fetch stock kmod rootfs assemble firmware
#   ./build.sh <step>...  # single steps
#   ./build.sh clean      # remove build/ and bin/ (keeps downloads)
#
# Requirements: bash curl tar zstd xz make fakeroot squashfs-tools (4.4+)
# and the stock firmware .bin in ./stock/ (see stock/README.md).
#
# Rules before a build, a pull request or an issue (AGENTS.md sections 9-11):
#   - Sync the checkout with github.com/PururinCollective/dpn-fx3060v-a1-openwrt
#     (git pull --ff-only). The build fetches origin and warns when the
#     checkout is behind.
#   - One firmware bank of the device keeps the stock D-Link firmware,
#     DEVICE_STOCK_MIN or newer (A1: V1.1.2, B1: V2.0.7). NijikaWrt (OpenWrt)
#     in both banks is [FAIL] (`nijika boot` on the device): write the stock
#     firmware back first. The build stops on stock firmware older than
#     DEVICE_STOCK_MIN (scripts/extract-stock.sh).
#   - A major new change (a new driver or kernel module, WireGuard, MikroTik
#     EoIP, IPIP or another tunnel) needs the UART (serial console) log of a
#     real device: boot and the feature in use. Once the feature is proven,
#     later changes to it do not need it. NijikaWrt is at an early stage and
#     not yet stable.
set -euo pipefail
cd "$(dirname "$0")"
. scripts/lib.sh

steps="${*:-all}"
case " $steps " in
	*" clean "*|*" distclean "*) ;;
	*) [ -n "${NIJIKA_SYNC_CHECKED:-}" ] || nijika_sync_check; export NIJIKA_SYNC_CHECKED=1 ;;
esac
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
