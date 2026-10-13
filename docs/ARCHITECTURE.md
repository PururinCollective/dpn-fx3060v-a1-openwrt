# NijikaWrt architecture (stage 1)

## Goals

1. Keep the **stock kernel** (Realtek 5.10.70, Cortina NE/PON drivers, rtw
   WiFi, VoIP DSP). Rewriting those drivers for an OpenWrt kernel is a later stage.
2. Run **OpenWrt userland** for management: LuCI, ubus/rpcd, apk packages,
   SSH, and a sane shell.
3. Keep the router **working like the original from the first boot**: the stock
   userland still reads the existing configuration (MIB) and runs
   PON/OMCI/WAN/WiFi/VoIP.

## Two userlands, one kernel

The stock rootfs is glibc 2.30 and OpenWrt is musl. Their loaders differ
(`ld-linux-aarch64.so.1` vs `ld-musl-aarch64.so.1`), but library names do clash
(`libgcc_s.so.1`, …), and the stock scripts hard-code paths such as
`/bin/sh`, `/bin/smuxctl` and `/var/config`. So the stock rootfs is kept
**complete and unmodified** at `/rtk`, and its programs run with `chroot /rtk`.
The chroot shares the kernel, PID space, network stack, `/proc`, `/sys` and
`/dev` with OpenWrt, and SysV IPC (`configd` message queues) works across it.

```
/                     OpenWrt squashfs + overlay (UBI rootfs_data)
├── rtk/              stock D-Link rootfs (from the stock firmware at build time)
│   ├── proc sys dev  mounted/bind-mounted by /etc/init.d/rtk-vendor
│   ├── var           own tmpfs (stock rc2 used a ramfs)
│   │   └── config    UBIFS ubi_Config, mounted by stock rc2: the MIB
│   ├── run           tmpfs
│   ├── bin/boa       NijikaWrt shim; bin/boa.stock = original
│   └── etc/nijika/   patched copy of the stock rc chain
├── lib/firmware  ──► /rtk/lib/firmware   (kernel firmware loader)
├── etc/serdes    ──► /rtk/etc/serdes     (ca-pon SerDes tables)
├── etc/conf      ──► /rtk/etc/conf       (compat.ko, cfg80211.ko)
├── config        ──► /rtk/var/config     (scfg.txt)
└── tmp/<x>       ──► /rtk/var/<x>        (var-mirror; never overrides host entries)
```

The mirrors exist because kernel threads (workqueues of the stock drivers)
resolve file paths against the root of PID 1, not the chroot.

## Boot sequence

1. U-Boot loads `ubi_k<n>` (stock FIT kernel) with `root=31:8|11`.
2. The kernel mounts the squashfs and runs `/sbin/init` (procd).
3. **Preinit**
   * `01_nijika_sysinfo`: board name `dlink,dpn-fx3060v-a1`, model
     "D-Link DPN-FX3060V (A1)".
   * `75_nijika_rootfs_data`: creates UBI volume `rootfs_data` (id 120) on first
     boot using the stock `ubimkvol` through the glibc loader
     (`/usr/libexec/rtk/glibc`), formats it by mounting, and handles a pending
     wipe (`.nijika_wipe`). sysupgrade leaves one with the kept config, which is
     restored as `/tmp/sysupgrade.tar`. The factory `fwu.sh` leaves one without,
     so a factory flash starts from OpenWrt defaults.
   * `80_mount_root`: fstools mounts the overlay from `rootfs_data`.
4. **procd init scripts**
   * `S10boot`, `S10system`, … (OpenWrt; netifd only manages loopback).
   * **`S11rtk-vendor`**: mounts proc/sys/dev/var/run inside `/rtk`, points
     `/proc/sys/kernel/modprobe` at the stock modprobe, and starts
     `/usr/libexec/rtk/vendor-boot`. That runs the patched stock rc chain
     (`/rtk/etc/nijika/rcS` → `rc.d/rc2..rc35`) in the chroot, waits for the stock
     "system up" marker, then runs `post-boot.d` hooks (resolv.conf, LAN
     management rules).
   * `S19dropbear`, `S50uhttpd`, `S12rpcd`: OpenWrt management.
   * **`S95nijika-ontd`**: refreshes `/tmp/nijika/pon.{env,json}` every 5 s for
     the banner, LuCI and `nijika info`; re-applies the LAN rules and `/var`
     mirror every 60 s.

### Stock rc lines disabled in the chroot

`scripts/patch-vendor.sh` copies `/etc/init.d/rcN` to `/etc/nijika/rc.d/` and
comments out these lines (the originals stay in place):

| file | line | reason |
|---|---|---|
| rc2 | `/etc/scripts/sysfs.sh`, `devpts.sh` | host mounts them for the chroot |
| rc2 | `/etc/scripts/checkroot.sh` | would remount `/` |
| rc2 | `mount -t ramfs ramfs /var` | chroot gets its own tmpfs from the host |
| rc2 | `echo /sbin/mdev > /proc/sys/kernel/hotplug`, `mdev -s` | procd handles hotplug |
| rc34 | `rtk_watchdog` | procd owns `/dev/watchdog` (also armed by U-Boot for trial boots) |

Other build-time changes to `/rtk`:

* `bin/boa` → `bin/boa.stock`, shim installed as `bin/boa`
* `home/httpd/boa.conf`: `Port 80` → `Port 8080` (used when `boa=stock`)
* `etc/inetd.conf`: `ssh` line commented (OpenWrt dropbear owns port 22)

## boa shim

`startup`, `libmib`, `cwmpClient` and the Realtek `systemd` daemon track the
web server through `/var/run/boa.pid` and signal it after config changes. The
shim (`/rtk/bin/boa`, a busybox sh script) writes the pid file, ignores
HUP/USR1/USR2 and sleeps. With `uci set nijika.vendor.boa=stock` it execs the
original boa instead, which serves the D-Link GUI on port 8080. That's handy for
settings LuCI doesn't cover yet.

## Configuration bridge

LuCI never edits stock files directly. The rpcd plugin
`/usr/libexec/rpcd/nijika` calls the same helpers as the `nijika` CLI
(`/usr/lib/nijika/*.sh`), and these run the stock tools in the chroot:

| data | tool | parser |
|---|---|---|
| scalars | `flash get/set KEY` | `kv.awk` |
| chain tables | `flash get TBL`, `flash set TBL.i.field` | `chain.awk` |
| OMCI MEs | `omcicli mib get <class>` | `me.awk` (ordered `[key,value]` pairs + raw) |
| PON/optics | `diag gpon get onu-state`, `diag pon get transceiver …` | `pon.sh` |
| VoIP | `voipflashcmd get/set NAME [VALUE] CHID PROXY` | |
| U-Boot env | `nv getenv/setenv` | |

Quick Setup writes:

| field | MIB |
|---|---|
| serial | `GPON_SN` |
| PLOAM | `GPON_PLOAM_PASSWD` |
| LOID | `LOID`, `LOID_PASSWD` |
| PPPoE | `ATM_VC_TBL.<i>.{pppUser,pppPasswd,vlan,vid,vprio,MTU}` (first `ChannelMode=2` record by default) |
| WiFi | `WLAN_MBSSIB_TBL.0.{ssid,wpaPSK}` + `SSID`/`WLAN_WPA_PSK` (wlan0), `WLAN1_MBSSIB_TBL.0.*` + `WLAN1_SSID`/`WLAN1_WPA_PSK` (wlan1); band from `WLAN*_PHY_BAND_SELECT` |
| VoIP | `voipflashcmd set … <line> 0` |

## Firewall and services

The stock `startup` builds the iptables/ebtables ruleset, NAT, PPPoE
(`spppd`), DHCP/DNS (`dnsmasq`), UPnP, IGMP proxy and TR-069, all from the
MIB. OpenWrt's `firewall4`, `dnsmasq`, `odhcpd` and `ppp` are not installed
(the stock kernel has no nftables anyway). `lan-mgmt` inserts accept rules for
TCP 22/80 on `br0` into the stock INPUT chain and re-checks them every minute.

## A/B upgrades

Two images come out of one build (see [FLASH_LAYOUT.md](FLASH_LAYOUT.md)):
`-factory.bin` (stock tar with `fwu.sh`, for the D-Link web GUI) and
`-sysupgrade.bin` (OpenWrt NAND sysupgrade tar + fwtool metadata).
`/usr/lib/nijika/fw.sh` detects the format, and `/lib/upgrade/platform.sh`
replaces the armsr disk logic:

* `REQUIRE_IMAGE_METADATA=1`: sysupgrade checks `supported_devices` against
  `dlink,dpn-fx3060v-a1`. Factory/stock tars have no metadata and need
  `-F`.
* `platform_check_image`: format detection, then md5 (factory) or fwtool CRC
  plus board (sysupgrade), squashfs magic, and size against the UBI volume.
* `platform_pre_upgrade`: runs in stage2 while the root is still mounted.
  Writes the other bank with `ubiupdatevol`, sets `sw_tryactive`, marks the
  overlay for a wipe and stores the kept config on it.
* `platform_do_upgrade` / `platform_copy_config`: nothing left to do.

Stock D-Link images use the factory format, so a forced sysupgrade, *PON →
Firmware Banks* or `nijika upgrade` also flashes back to stock.
