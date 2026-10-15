#!/bin/bash
# Native helpers for the stock chroot: compiled for the stock userland
# (aarch64, glibc 2.30) and linked against the stock libraries of the
# unpacked vendor tree, then installed into it.
#
#   scripts/build-helpers.sh <rtk-tree>     (called by assemble.sh)
#
# Compiler: zig cc (ZIG in build.conf), which can target an old glibc; a
# distribution cross gcc links against its own, newer glibc.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

RTK="${1:?usage: $0 <rtk-tree>}"
SRC="$TOPDIR/package/rtk-vendor/src"
OUT="$BUILD_DIR/helpers"
mkdir -p "$OUT"

# rtk-apply: libmib calls of the stock boa form handlers. Libraries as
# linked by the stock wlan_apply, which calls into libmib the same way.
src="$SRC/rtk-apply.c"
bin="$OUT/rtk-apply"
if [ ! -x "$bin" ] || [ "$src" -nt "$bin" ] || [ "$0" -nt "$bin" ]; then
	log "compiling rtk-apply"
	# Same libraries as the stock wlan_apply: libmib leaves symbols of
	# librtk, libpthread and libcrypto (MD5_*) to the program. librtk.so has
	# no SONAME, so linked by path the build host's path would end up in
	# DT_NEEDED: link against a stub that carries SONAME librtk.so,
	# the stock one is loaded at run time. The rest are linked by path
	# (they have SONAMEs).
	link="$OUT/link"
	rm -rf "$link"; mkdir -p "$link"
	# librtk symbols rtk-apply calls itself must exist in the stub
	printf 'int rt_gpon_deactivate(void) { return 0; }\nint rt_gpon_activate(int s) { return s; }\n' > "$link/stub.c"
	$ZIG cc -target aarch64-linux-gnu.2.30 -shared -Wl,-soname,librtk.so \
		-o "$link/librtk.so" "$link/stub.c" || die "rtk-apply: stub failed (ZIG='$ZIG')"
	libs=""
	for l in libmib.so.0 libpthread.so.0 libssl.so.1.1 libcrypto.so.1.1 libcrypt.so.1 libm.so.6; do
		libs="$libs $RTK/lib/$l"
	done
	# shellcheck disable=SC2086
	$ZIG cc -target aarch64-linux-gnu.2.30 -Os -s -Wall -Werror \
		-o "$bin.tmp" "$src" \
		-Wl,--allow-shlib-undefined -Wl,--no-as-needed "$link/librtk.so" $libs \
		|| die "rtk-apply: compile failed (ZIG='$ZIG')"
	mv "$bin.tmp" "$bin"
fi
install -m 0755 "$bin" "$RTK/bin/rtk-apply"
