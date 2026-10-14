#!/bin/sh
# Dry-run of the factory installer (firmware/fwu.sh) on a PC.
#
# Runs the fwu.sh shipped in the factory image against stubbed stock tools
# (nv, ubiupdatevol, mount, diag) and a fake UBI sysfs, through the
# situations the stock web upgrade
# can hit. Nothing touches real flash. Tools come from busybox; the script
# itself runs under the host POSIX sh, because busybox ash prefers its own
# applets (mount) over the stubs in PATH.
#
#   tools/fwu-dryrun.sh [factory.bin] [scenario-number...]

TOP="$(cd "$(dirname "$0")/.." && pwd)"
IMG="${1:-$(ls "$TOP"/bin/*-factory.bin 2>/dev/null | head -n 1)}"
[ $# -gt 0 ] && shift
BB=$(command -v busybox) || { echo "busybox is required"; exit 1; }
[ -f "$IMG" ] || { echo "no factory image (run ./build.sh first)"; exit 1; }

W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin"
for a in tar md5sum awk sed grep wc cut head cat rm mv mkdir touch sync rmdir readlink tr; do
	ln -s "$BB" "$W/bin/$a"
done

cat > "$W/bin/nv" <<'EOF'
#!/bin/sh
# U-Boot environment stub backed by $SIM/env
case "$1" in
	getenv)
		echo "Valid environment: 2"
		if [ -n "$2" ]; then grep "^$2=" "$SIM/env"; else cat "$SIM/env"; fi ;;
	setenv)
		if [ "$SIM_NV" = ro ]; then echo "nv setenv $2 $3 (ignored)" >> "$SIM/changes"; exit 0; fi
		grep -v "^$2=" "$SIM/env" > "$SIM/env.new"; mv "$SIM/env.new" "$SIM/env"
		[ $# -ge 3 ] && echo "$2=$3" >> "$SIM/env"
		echo "nv setenv $2 $3" >> "$SIM/changes" ;;
esac
EOF
cat > "$W/bin/ubiupdatevol" <<'EOF'
#!/bin/sh
echo "ubiupdatevol $1 <- $2 ($(wc -c < "$2") bytes)" >> "$SIM/changes"
EOF
cat > "$W/bin/mount" <<'EOF'
#!/bin/sh
[ "$SIM_MOUNT" = ok ] || exit 1
echo "mount $*" >> "$SIM/changes"
EOF
cat > "$W/bin/umount" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$W/bin/diag" <<'EOF'
#!/bin/sh
# switch PHY registers from $SIM/phy ("port reg2 reg3" lines); no file = no diag
[ -f "$SIM/phy" ] || exit 1
case "$*" in
	"rt_port get phy-reg port "*" page 0 register "[23])
		set -- $*
		awk -v p="$5" -v r="${9}" '$1 == p { printf "Port %s Page 0 Register %s: 0x%s\n", p, r, (r == 2 ? $2 : $3) }' "$SIM/phy" ;;
esac
EOF
chmod +x "$W/bin/nv" "$W/bin/ubiupdatevol" "$W/bin/mount" "$W/bin/umount" "$W/bin/diag"

# the installer exactly as shipped (device block filled in by mkfw.sh)
tar -xOf "$IMG" fwu.sh > "$W/fwu.sh" || { echo "no fwu.sh in $IMG"; exit 1; }

# The device the image was built for (its fwu.sh device block): the matching
# board answers with its PHY IDs, the "other" board differs on port 4
# (RTL8221B 0x001CC849, or no PHY when the image already expects one there).
eval "$(grep -E "^IMG_(DEVICE|MODEL|STOCK_MATCH|PHY_IDS)=" "$W/fwu.sh")"
[ -n "$IMG_PHY_IDS" ] || { echo "fwu.sh in $IMG has no device block"; exit 1; }
phy_lines() { # "id id ..." -> "port reg2 reg3" lines
	echo "$1" | tr ' ' '\n' | awk '{ printf "%d %s %s\n", NR - 1, toupper(substr($0, 1, 4)), toupper(substr($0, 5, 4)) }'
}
PHY_MATCH=$(phy_lines "$IMG_PHY_IDS")
other=$(echo "$IMG_PHY_IDS" | awk '{ $5 = ($5 == "001cc849") ? "ffffffff" : "001cc849"; print }')
PHY_OTHER=$(phy_lines "$other")
# stock /etc/version of this revision, and of another one
for v in "DPN-FX3060V_V1.1.2 -- Wed Nov 8 10:50:56 CST 2023" "DPN-FX3060V_V2.0.6 -- Mon Jan 1 00:00:00 CST 2024"; do
	if echo "$v" | grep -Eq "$IMG_STOCK_MATCH"; then STOCK=${STOCK:-$v}; else OTHER_STOCK=${OTHER_STOCK:-$v}; fi
done
[ -n "$STOCK" ] && [ -n "$OTHER_STOCK" ] || { echo "no sample stock version for '$IMG_STOCK_MATCH'"; exit 1; }

# UBI rounds a volume up to whole LEBs (126976 bytes): data_bytes as the
# kernel reports it for the sizes U-Boot creates (pfl_*_sz in the env).
LEB=126976
ubi_bytes() { echo $(( ($1 + LEB - 1) / LEB * LEB )); }

# scenario <title> <bank> <running root|-> <sw_active> <version> <overlay yes|no> <mount ok|fail> [rootfs vol bytes] [corrupt]
scenario() {
	title="$1" bank="$2" root="$3" active="$4" ver="$5" overlay="$6" mnt="$7" rsize="${8:-$(ubi_bytes 73400320)}" corrupt="$9"
	SIM="$W/sim"
	rm -rf "$SIM"
	mkdir -p "$SIM/sys/ubi0" "$SIM/run" "$SIM/mnt"
	export SIM SIM_MOUNT="$mnt" SIM_NV="${SIM_NV:-rw}"

	echo 2008 > "$SIM/sys/ubi0/avail_eraseblocks"
	echo 126976 > "$SIM/sys/ubi0/eraseblock_size"
	n=0
	dtb=$(ubi_bytes 262144) k=$(ubi_bytes 6291456) cfg=$(ubi_bytes 10485760)
	for v in ubi_Config:$cfg ubi_DTB0:$dtb ubi_k0:$k ubi_r0:$rsize ubi_DTB1:$dtb ubi_k1:$k ubi_r1:$rsize; do
		mkdir -p "$SIM/sys/ubi0_$n"
		echo "${v%%:*}" > "$SIM/sys/ubi0_$n/name"
		echo "${v#*:}" > "$SIM/sys/ubi0_$n/data_bytes"
		n=$((n + 1))
	done
	if [ "$overlay" = yes ]; then
		mkdir -p "$SIM/sys/ubi0_120"
		echo rootfs_data > "$SIM/sys/ubi0_120/name"
	fi

	if [ "$root" = - ]; then
		echo "console=ttyS0,115200 ubi.mtd=4 rootfstype=squashfs" > "$SIM/cmdline"
	else
		echo "console=ttyS0,115200 ubi.mtd=4 root=$root rootfstype=squashfs" > "$SIM/cmdline"
	fi
	printf 'sw_active=%s\nsw_commit=%s\nsw_tryactive=2\nsw_version0=DPN-FX3060V_V1.1.2\nsw_version1=DPN-FX3060V_V1.1.2\n' \
		"$active" "$active" > "$SIM/env"
	echo "$ver" > "$SIM/version"
	case "${SIM_PHY-match}" in
		match) echo "$PHY_MATCH" > "$SIM/phy" ;;
		other) echo "$PHY_OTHER" > "$SIM/phy" ;;
	esac

	cp "$IMG" "$SIM/run/img.tar"
	[ -n "$corrupt" ] && printf 'NIJIKA' | dd of="$SIM/run/img.tar" bs=1 seek=5000000 conv=notrunc 2>/dev/null

	echo "=============================================================================="
	echo " $title"
	echo " stock GUI asks for bank $bank | kernel root=$root | sw_active=$active"
	echo "=============================================================================="
	( cd "$SIM/run" && env PATH="$W/bin" \
		NIJIKA_SYS_UBI="$SIM/sys" NIJIKA_CMDLINE="$SIM/cmdline" \
		NIJIKA_VERSION_FILE="$SIM/version" NIJIKA_STATUS_FILE="$SIM/status" \
		NIJIKA_CONSOLE="$SIM/console" NIJIKA_MNT="$SIM/mnt" NIJIKA_FORCE_FILE="$SIM/force" \
		"${FWU_SH:-/bin/sh}" "$W/fwu.sh" "$bank" "$SIM/run/img.tar" )
	rc=$?
	echo "------------------------------------------------------------------------------"
	echo " exit code $rc, firmware_upgrade_status=$(cat "$SIM/status" 2>/dev/null || echo -)"
	sed 's/^/ flash\/env: /' "$SIM/changes" 2>/dev/null || true
	[ -s "$SIM/changes" ] || echo " flash/env: (nothing changed)"
	echo
}

run() {
	case "$1" in
		1) scenario "1. fresh install from stock (no OpenWrt overlay yet)" 0 31:11 1 "$STOCK" no fail ;;
		2) scenario "2. reinstall: earlier NijikaWrt overlay is marked for reset" 1 31:8 0 "$STOCK" yes ok ;;
		3) scenario "3. U-Boot env out of sync (bank 1 booted by hand)" 1 31:11 0 "$STOCK" no fail ;;
		4) scenario "4. corrupted upload" 0 31:11 1 "$STOCK" no fail 73400320 corrupt ;;
		5) scenario "5. wrong device (not a DPN-FX3060V firmware)" 0 31:11 1 "V2801F_V1.9.0 -- Fri Jan 1 00:00:00 CST 2021" no fail ;;
		6) scenario "6. rootfs larger than the target volume" 0 31:11 1 "$STOCK" no fail 16777216 ;;
		7) scenario "7. running bank unknown (no root= on the command line)" 0 - 1 "$STOCK" no fail ;;
		8) SIM_NV=ro scenario "8. env out of sync and the nv write does not stick" 1 31:11 0 "$STOCK" no fail ;;
		9) SIM_PHY=other scenario "9. other hardware revision (switch PHY IDs differ)" 0 31:11 1 "$STOCK" no fail ;;
		10) scenario "10. stock firmware of another revision" 0 31:11 1 "$OTHER_STOCK" no fail ;;
		11) SIM_PHY=none scenario "11. switch PHY IDs not readable (no diag)" 0 31:11 1 "$STOCK" no fail ;;
	esac
}

echo "image: $IMG ($IMG_MODEL)"
echo
if [ $# -gt 0 ]; then
	for s in "$@"; do run "$s"; done
else
	for s in 1 2 3 4 5 6 7 8 9 10 11; do run "$s"; done
fi
