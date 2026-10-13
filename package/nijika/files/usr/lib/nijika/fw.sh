# shellcheck shell=ash
# A/B firmware handling for the DPN-FX3060V. Requires common.sh.
#
# Two image formats are accepted:
#
#  factory     stock D-Link tar (also what the stock web GUI flashes):
#                fwu.sh dtb kimage rootfs fwu_ver hw_ver md5.txt
#              integrity: md5.txt
#  sysupgrade  OpenWrt NAND sysupgrade tar + fwtool metadata trailer:
#                sysupgrade-dlink_dpn-fx3060v-a1/{CONTROL,kernel,root,dtb}
#              integrity: fwtool trailer CRC, board: metadata supported_devices
#
# dtb/kernel/rootfs are written to ubi_DTB<n>/ubi_k<n>/ubi_r<n> of the bank
# we are NOT running from. U-Boot then boots it once (sw_tryactive) with a
# 60 s watchdog; the stock fw_loaded.sh commits it after a good boot.

FW_BOARD=dlink_dpn-fx3060v-a1
FW_META=/tmp/.nijika-fw-meta.json

# fw_detect IMAGE -> sets FW_FMT, FW_DTB, FW_KERNEL, FW_ROOT (tar member names)
fw_detect() {
	local list other
	FW_FMT=""
	list=$(tar -tf "$1" 2>/dev/null)
	if echo "$list" | grep -qx "sysupgrade-$FW_BOARD/root"; then
		FW_FMT=sysupgrade
		FW_DTB="sysupgrade-$FW_BOARD/dtb"
		FW_KERNEL="sysupgrade-$FW_BOARD/kernel"
		FW_ROOT="sysupgrade-$FW_BOARD/root"
	elif other=$(echo "$list" | sed -n 's|^sysupgrade-\([^/]*\)/.*|\1|p' | head -n 1) && [ -n "$other" ]; then
		echo "sysupgrade image for another board ($other)"
		return 1
	elif echo "$list" | grep -qx rootfs && echo "$list" | grep -qx kimage; then
		FW_FMT=factory
		FW_DTB=dtb
		FW_KERNEL=kimage
		FW_ROOT=rootfs
	else
		echo "not a DPN-FX3060V firmware image (neither factory nor sysupgrade format)"
		return 1
	fi
	return 0
}

fw_member_size() {
	tar -tvf "$1" "$2" 2>/dev/null | awk '{ print $3; exit }'
}

fw_check() {
	local img="$1" m want got size vol limit
	[ -f "$img" ] || { echo "image not found: $img"; return 1; }

	fw_detect "$img" || return 1

	for m in "$FW_DTB" "$FW_KERNEL" "$FW_ROOT"; do
		tar -tf "$img" "$m" >/dev/null 2>&1 || {
			echo "'$m' missing in $FW_FMT image"
			return 1
		}
	done

	case "$FW_FMT" in
		factory)
			tar -tf "$img" md5.txt >/dev/null 2>&1 || { echo "md5.txt missing"; return 1; }
			for m in "$FW_DTB" "$FW_KERNEL" "$FW_ROOT"; do
				want=$(tar -xOf "$img" md5.txt | awk -v f="$m" '$2 == f || $2 == "*" f { print $1; exit }')
				got=$(tar -xOf "$img" "$m" | md5sum | cut -d' ' -f1)
				[ -n "$want" ] && [ "$want" = "$got" ] || {
					echo "md5 mismatch for '$m'"
					return 1
				}
			done
			;;
		sysupgrade)
			# fwtool verifies the trailer CRC over the whole image.
			fwtool -q -i "$FW_META" "$img" || {
				echo "sysupgrade image metadata missing or checksum mismatch"
				return 1
			}
			jsonfilter -i "$FW_META" -e '@.supported_devices[*]' | grep -qx "dlink,dpn-fx3060v-a1" || {
				echo "sysupgrade image is not for the DPN-FX3060V (A1)"
				return 1
			}
			;;
	esac

	[ "$(tar -xOf "$img" "$FW_ROOT" | head -c 4)" = "hsqs" ] || {
		echo "rootfs is not a squashfs image"
		return 1
	}

	for m in "$FW_DTB:ubi_DTB0" "$FW_KERNEL:ubi_k0" "$FW_ROOT:ubi_r0"; do
		size=$(fw_member_size "$img" "${m%%:*}")
		vol=$(ubi_vol_dev "${m#*:}") || continue
		limit=$(cat "/sys/class/ubi/${vol#/dev/}/data_bytes" 2>/dev/null)
		[ -n "$limit" ] && [ "$size" -gt "$limit" ] && {
			echo "'${m%%:*}' ($size bytes) does not fit ${m#*:} ($limit bytes)"
			return 1
		}
	done

	return 0
}

# fw_target_info -> sets FW_TARGET (bank written by fw_flash), FW_TARGET_VER
# (its sw_version) and FW_TARGET_STOCK (1 when it holds non-NijikaWrt
# firmware, i.e. the stock D-Link fallback).
fw_target_info() {
	case "$(running_bank)" in
		0) FW_TARGET=1 ;;
		1) FW_TARGET=0 ;;
		*) FW_TARGET=""; return 1 ;;
	esac
	FW_TARGET_VER=$(nv_get "sw_version$FW_TARGET")
	case "$FW_TARGET_VER" in
		NijikaWrt*|"") FW_TARGET_STOCK=0 ;;
		*) FW_TARGET_STOCK=1 ;;
	esac
	return 0
}

# fw_check_target [replace_stock] -- never overwrite the stock firmware kept
# in the other bank unless explicitly allowed (sysupgrade -F, nijika upgrade
# --replace-stock, LuCI confirmation).
fw_check_target() {
	fw_target_info || { echo "cannot determine the running bank"; return 1; }
	if [ "$FW_TARGET_STOCK" = 1 ] && [ "$1" != 1 ]; then
		echo "bank $FW_TARGET holds the stock firmware ($FW_TARGET_VER); flashing would replace it."
		echo "To keep stock + NijikaWrt, update NijikaWrt from the stock bank with the -factory.bin image,"
		echo "or confirm replacing stock (sysupgrade -F, nijika upgrade --replace-stock)."
		return 1
	fi
	return 0
}

# Version string recorded as sw_version<n> (shown by the stock GUI too).
fw_version() {
	fw_detect "$1" >/dev/null || return 1
	case "$FW_FMT" in
		factory)
			tar -xOf "$1" fwu_ver 2>/dev/null | head -n 1 | sed 's/ *--.*$//'
			;;
		sysupgrade)
			fwtool -q -i "$FW_META" "$1" &&
				printf '%s_%s\n' "$(jsonfilter -i "$FW_META" -e '@.version.dist')" \
					"$(jsonfilter -i "$FW_META" -e '@.version.version')"
			;;
	esac
}

# fw_flash IMAGE [try|commit|none]
fw_flash() {
	local img="$1" mode="${2:-try}" cur target m member vol size ver

	fw_check "$img" || return 1

	cur=$(running_bank)
	case "$cur" in
		0) target=1 ;;
		1) target=0 ;;
		*) echo "cannot determine the running bank"; return 1 ;;
	esac

	echo "$FW_FMT image, running bank: $cur, writing bank: $target"

	for m in "$FW_DTB:ubi_DTB" "$FW_KERNEL:ubi_k" "$FW_ROOT:ubi_r"; do
		member="${m%%:*}"
		vol=$(ubi_vol_dev "${m#*:}$target") || {
			echo "UBI volume ${m#*:}$target not found"
			return 1
		}
		size=$(fw_member_size "$img" "$member")
		echo "writing $member ($size bytes) -> ${m#*:}$target ($vol)"
		tar -xOf "$img" "$member" | "$RTK_GLIBC" "$RTK/bin/ubiupdatevol" "$vol" -s "$size" - || {
			echo "ubiupdatevol failed for $vol"
			nv_set "sw_valid$target" 0
			return 1
		}
	done

	ver=$(fw_version "$img")
	nv_set "sw_version$target" "${ver:-unknown}"
	nv_set "sw_valid$target" 1

	case "$mode" in
		try)
			# Boot it once; stock fw_loaded.sh commits it after a good boot.
			nv_set sw_updater nijika
			nv_set sw_tryactive "$target"
			echo "bank $target will be tried on next boot (falls back to bank $cur on failure)"
			;;
		commit)
			nv_set sw_commit "$target"
			nv_set sw_active "$target"
			nv_set sw_tryactive 2
			echo "bank $target committed for next boot"
			;;
		*)
			echo "bank $target written, boot selection unchanged"
			;;
	esac
	sync
	return 0
}
