# D-Link DPN-FX3060V (B1): hardware notes

Facts measured on the user's own B1 over telnet (stock firmware, login lands
in a restricted CLI; `sh` enters the Linux shell), plus the stock firmware
`DPN-FX3060V_V2.0.3` (2024-08-02, `..._flowid.bin`). The measured unit runs
**V2.0.2** (kernel `#11 ... Sun Jan 14 2024`); the V2.0.3 `.bin` is newer and
is what NijikaWrt builds from. Both match `^DPN-FX3060V_V2\.`.

## SoC and boot

| | |
|---|---|
| SoC | Realtek RTL9607DQ "Taurus", Cortex-A55 (same as A1) |
| Device tree | `model = "Realtek Taurus ENG Board"`, `compatible = "realtek,taurus"` (identical string to A1) |
| Kernel | stock Realtek 5.10.70, ASDK64 gcc 10.2.0; `# CONFIG_BONDING is not set`, no nftables/TUN (same limits as A1) |
| cmdline | `console=ttyS0,115200 ubi.mtd=4 root=31:8 rootfstype=squashfs ... mtdparts=ca_spinand_flash:2048K(boot),256K(env),256K(env2),256K(static_conf),251648K(ubi_device)` |
| Kernel config hint | `CONFIG_MAC_PHY_RF_Parameter_V702B_Skyworth=y` — board derived from a Skyworth reference design (relevant to the GN630V port) |

## Ethernet

Switch PHY IDs (`diag rt_port get phy-reg port N page 0 register 2|3`):

| switch port | PHY ID | |
|---|---|---|
| 0-3 | `001ccac4` | internal GbE PHYs (same chip as A1) |
| 4, 5 | `001cc849` | **Realtek RTL8221B** (2.5G PHY) |
| 6 | `ffffffff` | no MDIO PHY |

* 2.5G path: `rtl8221b.ko` + `extGphy.ko` (loaded by `/etc/scripts/modutils.sh`);
  user tool `/bin/rtl8221b` forces the MAC speed on switch port 6/7.
* `diag rt_port get status port all` on the test unit: port 1 up 1000M (the LAN
  cable in use), port 6 up 10G (internal SerDes), others down. Front-panel
  port <-> switch-port labelling still needs a one-cable-per-port check (as on A1).
* A1 vs B1 differ clearly in the fingerprint (A1 = `ff` on ports 4-6), so the
  installers refuse the wrong image.

## Flash / UBI  (from `ubinfo -a`; LEB = 126976 B)

UBI device ubi0: 1966 LEBs total (238 MiB), 788 free (95 MiB).

| volume | size | note |
|---|---|---|
| ubi_Config | 10.1 MiB | stock MIB (`/var/config`) |
| ubi_DTB0 / DTB1 | 372 KiB | device tree, per bank |
| ubi_k0 / ubi_k1 | 6,348,800 B (6.1 MiB) | kernel, per bank → `DEVICE_KERNEL_MAX` |
| ubi_r0 / ubi_r1 | 26,284,032 B (25.1 MiB) | **rootfs, per bank → `DEVICE_ROOTFS_MAX`** |
| ubi_framework1 / 2 | 8.1 MiB each | YueMe framework (NijikaWrt leaves it) |
| ubi_apps | 48.1 MiB | apps store (NijikaWrt leaves it) |

**Key difference from A1:** A1's rootfs volume is ~70 MiB; B1's is only
25.1 MiB, because the B1 reserves the framework/apps volumes. The NijikaWrt B1
rootfs (~25.2 MB) fits with ~1 MB headroom — watch the package list. The
`rootfs_data` overlay comes from the 95 MiB of free UBI space, not ubi_r0.

## NijikaWrt build

* `DEVICE=dpn-fx3060v-b1 ./build.sh` builds from V2.0.3; rootfs ~25.2 MB.
* WireGuard/CAKE modules need the Realtek SDK rebuilt against this kernel
  (`./build.sh kmod`); not built yet.
* Stock login CLI has a buffer overflow (`stack smashing detected`) when fed a
  long command line — noted, not used by NijikaWrt.
