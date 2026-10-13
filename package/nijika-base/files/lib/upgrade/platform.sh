# NijikaWrt sysupgrade for the D-Link DPN-FX3060V (A1).
#
# The image always goes to the OTHER bank. If that bank holds the stock
# D-Link firmware, the check fails (forceable with -F) so stock is never
# replaced by accident.
#
# Images: *-sysupgrade.bin (OpenWrt NAND sysupgrade tar with fwtool
# metadata: board dlink,dpn-fx3060v-a1). The factory/stock D-Link tar is
# accepted as well, but only forced (`sysupgrade -F`, LuCI "Force upgrade")
# since it carries no metadata: that is the way back to stock firmware.
#
# The device has two firmware banks (ubi_{DTB,k,r}{0,1}). Instead of
# overwriting the running system from a ramdisk, the new image is written
# to the inactive bank before stage2 switches to the ramfs, and U-Boot is
# told to try it once. The overlay (UBI volume rootfs_data) is wiped on the
# next boot by /lib/preinit/75_nijika_rootfs_data, restoring the kept
# configuration if requested.

REQUIRE_IMAGE_METADATA=1

. /usr/lib/nijika/common.sh
. /usr/lib/nijika/fw.sh

platform_check_image() {
	[ "$#" -gt 1 ] && return 1
	fw_check "$1" || return 1
	# The other bank may hold the stock D-Link fallback: only replace it when
	# forced (sysupgrade -F / LuCI "Force upgrade").
	fw_check_target || return 1
	[ "$FW_FMT" = factory ] &&
		v "Factory/stock image: it is written to the inactive bank like a sysupgrade image."
	return 0
}

platform_pre_upgrade() {
	rm -f /tmp/nijika-upgrade.ok
	fw_flash "$1" try || return 0
	touch /tmp/nijika-upgrade.ok

	if grep -q " /overlay ubifs " /proc/mounts; then
		touch /overlay/.nijika_wipe
		if [ -n "$UPGRADE_BACKUP" ] && [ -f "$UPGRADE_BACKUP" ]; then
			cp -f "$UPGRADE_BACKUP" /overlay/.nijika_keep.tgz
		fi
		sync
	fi
}

platform_do_upgrade() {
	if [ -f /tmp/nijika-upgrade.ok ]; then
		v "NijikaWrt: new firmware written to the inactive bank"
	else
		v "NijikaWrt: upgrade FAILED, rebooting into the current firmware"
	fi
}

platform_copy_config() {
	# Handled in platform_pre_upgrade (config kept on the UBI overlay).
	return 0
}
