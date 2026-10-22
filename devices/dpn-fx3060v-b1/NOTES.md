# D-Link DPN-FX3060V (B1): hardware notes

Measured on a B1 running **stock firmware V2.0.2** (kernel `#11 ... Sun Jan 14
2024`), over a telnet shell (the stock login lands in a restricted CLI; `sh`
enters the Linux shell). The raw command output these values come from is
attached to the pull request, with serials / MACs / GPON SN / LOID / passwords
removed. The stock firmware `.bin` used to build is `DPN-FX3060V_V2.0.3`
(2024-08-02); it is newer than the measured unit. Both match
`^DPN-FX3060V_V2\.`.

## SoC and boot

| | |
|---|---|
| SoC | Realtek RTL9607DQ "Taurus", Cortex-A55 (same as A1) |
| Device tree | `model = "Realtek Taurus ENG Board"`, `compatible = "realtek,taurus"` (identical string to A1) |
| Kernel | stock Realtek 5.10.70, ASDK64 gcc 10.2.0; `# CONFIG_BONDING is not set`, no nftables/TUN (same limits as A1) |
| cmdline | `console=ttyS0,115200 ubi.mtd=4 root=31:8 rootfstype=squashfs ... mtdparts=ca_spinand_flash:2048K(boot),256K(env),256K(env2),256K(static_conf),251648K(ubi_device)` |

## Ethernet

Switch PHY IDs — raw `diag rt_port get phy-reg port N page 0 register 2|3`:

| switch port | reg 2 / reg 3 | PHY ID | |
|---|---|---|---|
| 0-3 | `0x001C` / `0xCAC4` | `001ccac4` | internal GbE PHYs (same chip as A1) |
| 4 | `0x001C` / `0xC849` | `001cc849` | Realtek RTL8221B (2.5G) |
| 5 | `0x001C` / `0xC849` | `001cc849` | same ID as port 4 (see below) |
| 6 | `0xFFFF` / `0xFFFF` | `ffffffff` | no MDIO PHY |

What the stock driver does with the 2.5G PHY (from the boot log, `extGphy`):

```
extGphy: read Ethernet PHY 7 IDs(0x1c 0xc849): phy_oui 0x732, phy_model 0x4
extGphy: detect Eth PHY RTL8226B at PHY addr 7
extGphy: Set port 4 as HiSGMII/SGMII (Default 1G)
extGphy: Set port 6 as XFI (10G)
```

* So there is one external PHY (RTL8221B / RTL8226B-VB, MDIO address 7). The
  stock driver attaches it to the **HSGMII data path on switch port 4**, and
  brings up an XFI/10G SerDes on port 6.
* `diag ... phy-reg` returns `0x001CC849` on **both** port-index 4 and 5. Why
  the same PHY answers on two port indices is not certain from this output —
  most likely the switch's port→MDIO mapping routes both indices to the one
  external MDIO address. It is recorded here as measured; `DEVICE_PHY_IDS`
  uses the raw per-index reads, which is what the installers compare.
* `/bin/rtl8221b` (the stock user tool) accepts switch port `5`, `6` or `7` in
  its usage string.
* `diag rt_port get status port all` on the test unit: port 1 up 1000M (the LAN
  cable in use), port 6 up 10G (internal SerDes), others down. Front-panel
  port ↔ switch-port labelling still needs a one-cable-per-port check (as on A1).
* A1 vs B1 differ clearly in the fingerprint (A1 = `0xFFFF` on ports 4-6), so
  the installers refuse the wrong image.

## Flash / UBI

U-Boot environment (`nv getenv`), the size values the installers key off:

| var | value | |
|---|---|---|
| `pfl_kernel1_sz` | `0x600000` | 6,291,456 B — bytes U-Boot reads from `ubi_k<bank>` → `DEVICE_KERNEL_MAX` |
| `pfl_rootfs1_sz` | `0x4600000` | 73,400,320 B (70 MiB) — the U-Boot rootfs *region*, same as A1 |
| `pfl_fdt1_sz` | `0x40000` | device tree |

UBI volumes (`ubinfo -a`; LEB = 126976 B, ubi0 = 1966 LEBs / 238 MiB, 788 free):

| volume | size | note |
|---|---|---|
| ubi_Config | 10.1 MiB | stock MIB (`/var/config`) |
| ubi_DTB0 / DTB1 | 372 KiB | device tree, per bank |
| ubi_k0 / ubi_k1 | 6,348,800 B (50 LEBs) | kernel volume; only `0x600000` is read, so `KERNEL_MAX` = `pfl_kernel1_sz` |
| ubi_r0 / ubi_r1 | 26,284,032 B (207 LEBs) | **rootfs volume → `DEVICE_ROOTFS_MAX`** (the build limit) |
| ubi_framework1 / 2 | 8.1 MiB each | YueMe framework (NijikaWrt leaves it) |
| ubi_apps | 48.1 MiB | apps store (NijikaWrt leaves it) |

**Key difference from A1:** the U-Boot rootfs *region* is 70 MiB on both
revisions (`pfl_rootfs1_sz = 0x4600000`), but the B1 UBI only creates a
**25.1 MiB** `ubi_r0` volume, because it carves ~45 MiB into
`ubi_framework1/2` + `ubi_apps`. The rootfs is written with `ubiupdatevol`, so
the real limit is the volume size, not the region — hence `DEVICE_ROOTFS_MAX`
is the volume size. `fwu.sh` also checks the rootfs against the live volume
`data_bytes` at install time. The NijikaWrt B1 rootfs (~25.2 MB) fits with
~1 MB headroom — watch the package list. The `rootfs_data` overlay comes from
the free UBI space, not `ubi_r0`.

## First-boot overlay (busy UBI)

On the first boot after a factory flash the B1 came up with a read-only root:
dropbear could not write host keys and `/etc/config/rtk` could not be created.
The LuCI kernel log around that time showed `ubi0 error: ubi_open_volume:
cannot open device 0, volume 0, error -16` (EBUSY). The read-only-boot
`dmesg`/`logread` was not kept across the reboots, so the exact cause is a
**hypothesis**: UBI is briefly busy right after attach, so creating the
`rootfs_data` overlay volume or its first UBIFS mount (both in
`lib/preinit/75_nijika_rootfs_data`) races UBI settling and fails, leaving
`mount_root` with no overlay. A second boot found the volume ready. The preinit
hook now retries the create path (bounded) and logs each step to `/dev/kmsg`.

## NijikaWrt build

* `DEVICE=dpn-fx3060v-b1 ./build.sh`; rootfs ~25.2 MB (within the 25.1 MiB limit).
* WireGuard / CAKE kernel modules are not included: `./build.sh kmod` needs the
  stock kernel source tree. (A module built from vanilla kernel.org 5.10.70
  loads — vermagic matches, `MODVERSIONS` is off — but crashes the kernel when
  the interface is created, because the Realtek kernel's struct layouts differ.)
* The stock login CLI aborts with `stack smashing detected` on a long command
  line; NijikaWrt does not use it.
