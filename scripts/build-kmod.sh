#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-only

# Kernel modules for the stock Realtek 5.10.70 kernel (KMOD_CONFIG in
# build.conf: WireGuard and the crypto libraries it selects, the CAKE qdisc),
# built so the stock kernel takes them:
#   - source: the kernel tree of the Realtek Luna SDK (KERNEL_SDK), the tree
#     D-Link's kernel comes from. Prepared once into
#     dl/linux-5.10.70-rtk.tar.zst (links fixed, Realtek directories the
#     Kconfig files need), so later builds do not need the SDK.
#   - config: the stock kernel's own (IKCONFIG from build/stock/kimage) plus
#     KMOD_CONFIG as modules; the build stops if anything built into the
#     kernel would change.
#   - compiler: gcc 10.2 like the stock kernel (Realtek ASDK64 10.2.0),
#     Bootlin's aarch64 toolchain (KMOD_TOOLCHAIN_URL, sha256 checked).
#   - symbols: modpost checks the modules against the stock kernel's
#     exports (scripts/ksymtab.py), vermagic against the stock modules'.
# Output: build/kmod/<kernel>/*.ko, modules.load (load order) and a
# <module>.load per feature module (wireguard.load, sch_cake.load: it and its
# dependencies). Without the SDK or its prepared tree the step is skipped
# with a warning and the image has no WireGuard and no CAKE.
# A new module (a driver, WireGuard, a tunnel such as MikroTik EoIP or IPIP)
# is a major change: the pull request needs the UART log of a real device,
# boot and the feature in use (AGENTS.md section 11). Once the module is
# proven, later changes to it do not need it.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

need make perl bc rsync zstd tar python3 unsquashfs

KVER=5.10.70
KNAME=linux-$KVER-rtk
KTAR="$DL_DIR/$KNAME.tar.zst"
KTOP="$BUILD_DIR/kernel"          # extracted tree: $KTOP/$KNAME (+ rtk_voip, ca_packages)
KSRC="$KTOP/$KNAME"
OUT="$BUILD_DIR/kmod/$KVER"
TC_NAME=$(basename "$KMOD_TOOLCHAIN_URL" .tar.bz2)
TC_DIR="$BUILD_DIR/toolchain/$TC_NAME"
CROSS="$TC_DIR/bin/aarch64-linux-"
KSTOCK="$BUILD_DIR/kmod/stock-kernel"

# Options that differ between the SDK tree's Kconfig and D-Link's tree:
# symbols only one of them knows (drivers, board, ISP flags) and the
# compiler identity. Checked: none of them is used in a header.
KCONFIG_DRIFT='CC_VERSION_TEXT|LD_VERSION|NETLINK_END_DUMP_WHEN_TRUNCATED|SHARE_XSTAL|RTK_SKB_DATA_PAGE_SIZE_2K_MODE|RTW_EFEM_IDENTIFY_WITH_FLASH|TM|ARM64_CRYPTO'

# --- toolchain ---------------------------------------------------------------

toolchain() {
	local tb="$DL_DIR/$TC_NAME.tar.bz2"
	[ -x "${CROSS}gcc" ] && return 0
	mkdir -p "$DL_DIR" "$BUILD_DIR/toolchain"
	if [ ! -f "$tb" ]; then
		log "downloading $TC_NAME (gcc 10.2, like the stock kernel)"
		curl -fL --retry 3 -o "$tb.part" "$KMOD_TOOLCHAIN_URL"
		mv "$tb.part" "$tb"
	fi
	echo "$KMOD_TOOLCHAIN_SHA256  $tb" | sha256sum -c --quiet || die "$tb: sha256 mismatch"
	tar -xjf "$tb" -C "$BUILD_DIR/toolchain"
	"${CROSS}gcc" --version | head -n 1 >&2
}

# --- kernel source -----------------------------------------------------------

# The SDK tree as a self-contained tarball: sources only, symlinks that
# pointed into the SDK by absolute path made relative, and the directories
# outside the tree that its Kconfig files or links reach.
prepare_tree() {
	local sdk="$KERNEL_SDK" tmp
	[ -d "$sdk/linux-5.10.x/arch/arm64" ] || return 1
	log "preparing $KNAME from the Realtek SDK in $sdk (once; slow on a FUSE mount)"
	tmp="$BUILD_DIR/kernel.prep"
	rm -rf "$tmp"
	mkdir -p "$tmp/$KNAME" "$tmp/rtk_voip/kernel" "$tmp/rtk_voip/aipc_char" \
		"$tmp/ca_packages/ca-network-engine/1.0-r0" "$tmp/ca_packages/ca-plat/1.0-r0"
	local ex=(--exclude='*.o' --exclude='*.ko' --exclude='*.a' --exclude='.*.cmd' --exclude='*.mod'
		--exclude='*.mod.c' --exclude='.tmp_*')
	rsync -a "${ex[@]}" --exclude='vmlinux*' --exclude='/vmlinuz' --exclude='/System.map' \
		--exclude='/Documentation/' --exclude='/user_headers/' \
		--exclude='/tools/testing/' --exclude='/.config' --exclude='/include/config/' \
		--exclude='/include/generated/' --exclude='/arch/*/include/generated/' \
		--exclude='/Module.symvers' --exclude='/modules.*' --exclude='/modules-only.symvers' \
		"$sdk/linux-5.10.x/" "$tmp/$KNAME/"
	mkdir -p "$tmp/$KNAME/Documentation"
	cp "$sdk/linux-5.10.x/Documentation/Kconfig" "$tmp/$KNAME/Documentation/"
	rsync -a "${ex[@]}" "$sdk/rtk_voip/kernel/" "$tmp/rtk_voip/kernel/"
	rsync -a "${ex[@]}" "$sdk/rtk_voip/aipc_char/" "$tmp/rtk_voip/aipc_char/"
	rsync -a "${ex[@]}" "$sdk/ca_packages/ca-network-engine/1.0-r0/ca-network-engine-1.0" \
		"$tmp/ca_packages/ca-network-engine/1.0-r0/"
	rsync -a "${ex[@]}" "$sdk/ca_packages/ca-plat/1.0-r0/ca-plat-1.0" "$tmp/ca_packages/ca-plat/1.0-r0/"
	cp "$sdk/autoconf.h" "$tmp/autoconf.h"
	chmod -R u+rwX "$tmp"
	# absolute links into the SDK's own tree -> relative
	python3 -I - "$tmp/$KNAME" <<'PY'
import os, sys
top = sys.argv[1]
pfx = '/root/SDK/rtl819x/linux-5.10.x/'
n = 0
for d, dirs, files in os.walk(top):
    for f in dirs + files:
        p = os.path.join(d, f)
        if os.path.islink(p) and os.readlink(p).startswith(pfx):
            t = os.path.join(top, os.readlink(p)[len(pfx):])
            os.unlink(p)
            os.symlink(os.path.relpath(t, d), p)
            n += 1
sys.stderr.write('[nijika] %d absolute links made relative\n' % n)
PY
	mkdir -p "$DL_DIR"
	tar -C "$tmp" -cf - . | zstd -q -T0 -10 -o "$KTAR.part"
	mv "$KTAR.part" "$KTAR"
	rm -rf "$tmp"
	log "kept as $KTAR ($(du -h "$KTAR" | cut -f1))"
}

# --- build -------------------------------------------------------------------

kmake() {
	# LEX/YACC: the tree ships the generated kconfig parser. extract-cert
	# (a host tool for the built-in keyring) is not needed for modules.
	make -C "$KSRC" ARCH=arm64 CROSS_COMPILE="$CROSS" LEX=true YACC=true \
		CONFIG_SYSTEM_TRUSTED_KEYRING= -j"$(nproc)" "$@"
}

modinfo_field() { # ko field
	"${CROSS}objcopy" -O binary --only-section=.modinfo "$1" /dev/stdout 2>/dev/null |
		tr '\0' '\n' | sed -n "s/^$2=//p" | head -n 1
}

if [ ! -f "$KTAR" ] && ! prepare_tree; then
	warn "no kernel tree: neither $KTAR nor the Realtek SDK in KERNEL_SDK=$KERNEL_SDK; building without kernel modules (no WireGuard, no CAKE)"
	rm -rf "$OUT"
	exit 0
fi
[ -f "$STOCK_DIR/kimage" ] || die "no stock kernel: run './build.sh stock' first"

toolchain

log "stock kernel: config and exports"
python3 -I "$TOPDIR/scripts/kimage.py" "$STOCK_DIR/kimage" "$KSTOCK"
grep -q "^# Linux/arm64 $KVER " "$KSTOCK/config" || die "the stock kernel is not $KVER"
python3 -I "$TOPDIR/scripts/ksymtab.py" "$KSTOCK/Image" > "$KSTOCK/vmlinux.symvers"
unsquashfs -q -cat "$STOCK_DIR/rootfs" "lib/modules/$KVER/kernel/net/netfilter/nf_conntrack_tftp.ko" \
	> "$KSTOCK/ref.ko" 2>/dev/null || die "no stock module to compare vermagic with"
stock_vermagic=$(modinfo_field "$KSTOCK/ref.ko" vermagic)
[ -n "$stock_vermagic" ] || die "no vermagic in the stock modules"

log "extracting $KNAME"
rm -rf "$KTOP"
mkdir -p "$KTOP"
zstd -q -dc "$KTAR" | tar -C "$KTOP" -xf -

cp "$KSTOCK/config" "$KSRC/.config"
kmake olddefconfig >/dev/null
cp "$KSRC/.config" "$KSTOCK/config.base"
for o in $KMOD_CONFIG; do
	"$KSRC/scripts/config" --file "$KSRC/.config" --module "$o"
done
kmake olddefconfig >/dev/null

# Nothing built into the kernel may change: only new modules (=m) and the
# known Kconfig drift between the SDK tree and D-Link's
changed=$(diff <(grep '^CONFIG_' "$KSTOCK/config" | sort) <(grep '^CONFIG_' "$KSRC/.config" | sort) |
	sed -n 's/^[<>] //p' | grep -v -E "^CONFIG_($KCONFIG_DRIFT)=" | grep -v -E '=m$' || true)
if [ -n "$changed" ]; then
	die "the module config changes the built-in kernel config:
$changed"
fi

log "modules_prepare"
kmake modules_prepare >"$BUILD_DIR/kmod/prepare.log" 2>&1 || { tail -n 20 "$BUILD_DIR/kmod/prepare.log"; die "modules_prepare failed"; }
cp "$KSTOCK/vmlinux.symvers" "$KSRC/Module.symvers"

# The directories of the new modules. lib/crypto and arch/arm64/crypto need
# each other (libchacha20poly1305 calls the NEON chacha/poly1305, which fall
# back to libchacha): lib/crypto first with missing symbols allowed, then
# again once the NEON modules exist, strictly and with their dependencies.
# net/sched: only CAKE is a module there, the other qdiscs are built in.
dirs="lib/crypto arch/arm64/crypto drivers/net/wireguard net/sched"
symvers() { # dirs...: their Module.symvers, for KBUILD_EXTRA_SYMBOLS
	local d
	for d in "$@"; do [ -f "$KSRC/$d/Module.symvers" ] && printf '%s ' "$KSRC/$d/Module.symvers"; done
}
build_dir() { # dir [warn]
	log "building $1${2:+ (pass 1)}"
	kmake M="$KSRC/$1" KBUILD_EXTRA_SYMBOLS="$(symvers $dirs)" ${2:+KBUILD_MODPOST_WARN=1} modules \
		>"$BUILD_DIR/kmod/build.log" 2>&1 ||
		{ grep -E 'error|ERROR|undefined' "$BUILD_DIR/kmod/build.log" | head -n 20; die "building $1 failed (see build/kmod/build.log)"; }
}
build_dir lib/crypto warn
build_dir arch/arm64/crypto
build_dir lib/crypto
build_dir drivers/net/wireguard
build_dir net/sched

rm -rf "$OUT"
mkdir -p "$OUT"
for d in $dirs; do
	find "$KSRC/$d" -maxdepth 1 -name '*.ko' -exec cp {} "$OUT/" \;
done
for ko in "$OUT"/*.ko; do
	vm=$(modinfo_field "$ko" vermagic)
	[ "$vm" = "$stock_vermagic" ] || die "$(basename "$ko"): vermagic '$vm', the stock kernel wants '$stock_vermagic'"
	"${CROSS}strip" --strip-debug "$ko"
done

# load order: dependencies (modinfo depends=) first
todo=$(cd "$OUT" && ls ./*.ko | sed 's|^\./||; s|\.ko$||')
: > "$OUT/modules.load"
while [ -n "$todo" ]; do
	next=
	for m in $todo; do
		ok=1
		for dep in $(modinfo_field "$OUT/$m.ko" depends | tr ',' ' '); do
			grep -qx "$(echo "$dep" | tr _ -)" "$OUT/modules.load" ||
				grep -qx "$dep" "$OUT/modules.load" || { ok=0; break; }
		done
		if [ $ok = 1 ]; then echo "$m" >> "$OUT/modules.load"; else next="$next $m"; fi
	done
	[ "$(echo $next)" != "$(echo $todo)" ] || die "module dependencies do not resolve: $next"
	todo=$(echo $next)
done

# A load list per feature, so that it loads only its own modules: those built
# in its directories, in load order. Not from depends= alone: libcurve25519
# (a self-test, nothing imports it) is WireGuard's too.
feature_load() { # feature dirs...: <feature>.load, when <feature>.ko was built
	local f=$1 d
	shift
	[ -f "$OUT/$f.ko" ] || return 0
	for d in "$@"; do find "$KSRC/$d" -maxdepth 1 -name '*.ko' -printf '%f\n'; done |
		sed 's/\.ko$//' | grep -Fx -f - "$OUT/modules.load" > "$OUT/$f.load"
}
feature_load wireguard lib/crypto arch/arm64/crypto drivers/net/wireguard
feature_load sch_cake net/sched
cp "$KSRC/.config" "$OUT/kernel.config"
log "kernel modules for $KVER: $(tr '\n' ' ' < "$OUT/modules.load")($(du -sh "$OUT" | cut -f1))"
