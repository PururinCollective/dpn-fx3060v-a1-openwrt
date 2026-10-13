#!/bin/sh
# NijikaWrt firmware upgrade script, executed by the STOCK firmware's web
# upgrade (boa) when flashing NijikaWrt from D-Link firmware:
#   sh fwu.sh <bank 0|1> <image.tar>
# Same contract as the stock luna fwu.sh: verify md5, write dtb/kimage/rootfs
# into ubi_DTB<n>/ubi_k<n>/ubi_r<n>, record sw_version<n>.

d_img="dtb"
k_img="kimage"
r_img="rootfs"
img_ver="fwu_ver"
md5_cmp="md5.txt"
md5_tmp="md5_tmp"
md5_rt_result="md5_rt_result.txt"
env_sw_ver="env_sw_ver.txt"

bank="$1"
tar_name="$2"

case "$bank" in
	0|1) ;;
	*) echo "Invalid image destination: $bank"; exit 1 ;;
esac

[ -f "$tar_name" ] || { echo "Image $tar_name not found"; exit 1; }

check_md5() {
	tar -xf "$tar_name" "$1" -O | md5sum | sed 's/-/'"$1"'/g' > $md5_rt_result
	grep " $1\$" $md5_cmp > $md5_tmp
	if ! diff $md5_rt_result $md5_tmp >/dev/null; then
		echo "$1 md5_sum inconsistent, aborted image updating !"
		exit 1
	fi
}

get_vol_dev() {
	info=$(ubinfo -d 0 -N "$1")
	set $info
	echo "/dev/ubi0_$3"
}

tar -xf "$tar_name" $md5_cmp || { echo "md5.txt missing"; exit 1; }
check_md5 $d_img
check_md5 $k_img
check_md5 $r_img
echo "Integrity of $k_img & $r_img is okay."

tar -xf "$tar_name" $img_ver || { echo "1" > /var/firmware_upgrade_status; echo "no fwu_ver in image"; exit 1; }
echo "Try to upgrade firmware version from `cat /etc/version`"
echo "                                  to `cat $img_ver`"

vdimg=$(get_vol_dev "ubi_DTB${bank}")
vkimg=$(get_vol_dev "ubi_k${bank}")
vrimg=$(get_vol_dev "ubi_r${bank}")

tar -xf "$tar_name" $d_img && ubiupdatevol "$vdimg" $d_img || { echo "writing $d_img failed"; exit 1; }
rm -f $d_img
tar -xf "$tar_name" $k_img && ubiupdatevol "$vkimg" $k_img || { echo "writing $k_img failed"; exit 1; }
rm -f $k_img
tar -xf "$tar_name" $r_img && ubiupdatevol "$vrimg" $r_img || { echo "writing $r_img failed"; exit 1; }
rm -f $r_img

sed 's/ *--.*$//' $img_ver | head -n 1 > $env_sw_ver
nv setenv sw_version"$bank" "`cat $env_sw_ver`"

# A factory flash is a fresh install. The OpenWrt overlay (UBI volume
# rootfs_data, shared by both banks) may still hold settings from an earlier
# NijikaWrt; have the next NijikaWrt boot reset it (handled in preinit).
for d in /sys/class/ubi/ubi0_*; do
	[ "`cat $d/name 2>/dev/null`" = "rootfs_data" ] || continue
	mkdir -p /tmp/nijika_data
	if mount -t ubifs ubi0:rootfs_data /tmp/nijika_data 2>/dev/null; then
		rm -f /tmp/nijika_data/.nijika_keep.tgz
		touch /tmp/nijika_data/.nijika_wipe
		sync
		umount /tmp/nijika_data
		echo "OpenWrt settings will be reset on first boot (factory install)."
	fi
	rmdir /tmp/nijika_data 2>/dev/null
done

rm -f $md5_cmp $md5_tmp $md5_rt_result $img_ver $env_sw_ver "$tar_name"

echo "Successfully updated image $bank!!"
exit 0
