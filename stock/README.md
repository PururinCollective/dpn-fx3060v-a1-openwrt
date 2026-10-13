# Stock firmware drop-in

Put the original D-Link DPN-FX3060V (A1) firmware here, e.g.

    DPN-FX3060V_V1.1.2_20231108_1050_XSTP.bin

The file is a plain tar (`fwu.sh dtb kimage rootfs fwu_ver hw_ver md5.txt`).
NijikaWrt reuses its kernel (`kimage`), device tree (`dtb`) and the Realtek
userland (`rootfs`, mounted as the `/rtk` vendor chroot). The firmware is
D-Link property and is never committed to this repository.

Tested with: `V1.1.2_20231108` (Linux 5.10.70, glibc 2.30, SDK VoIP-1.6).
