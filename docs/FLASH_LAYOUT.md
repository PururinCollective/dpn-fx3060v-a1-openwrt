# DPN-FX3060V (A1) flash layout and boot banks

Taken from the factory UART log (`teraterm_factory.log`, U-Boot 2020.01,
firmware V1.1.2).

## SPI-NAND (256 MiB, 128 KiB blocks, 2 KiB pages)

Kernel command line (built by U-Boot):

```
earlycon=serial,0xf43291b0 console=ttyS0,115200 ubi.mtd=4 root=31:11 rootfstype=squashfs
swiotlb=noforce mtdparts=ca_spinand_flash:2048K(boot),256K@0x280000(env),256K@0x2C0000(env2),
256K@0x300000(static_conf),251648K@0x340000(ubi_device)
```

| mtd | name | offset | size | content |
|---|---|---|---|---|
| mtd0 | boot | 0x000000 | 2 MiB | ATF BL1/BL2/BL31 + U-Boot (`taurus_spi_nand_loader.img`) |
| mtd1 | env | 0x280000 | 256 KiB | U-Boot environment (redundant copy 1) |
| mtd2 | env2 | 0x2C0000 | 256 KiB | U-Boot environment (redundant copy 2) |
| mtd3 | static_conf | 0x300000 | 256 KiB | calibration / static config |
| mtd4 | ubi_device | 0x340000 | 245.75 MiB | UBI, 1966 PEBs (LEB 124 KiB) |

## UBI volumes (ubi0)

| vol | name | size | |
|---|---|---|---|
| 0 | `ubi_Config` | 0xA00000 (10 MiB) | UBIFS, mounted at `/var/config`: stock MIB (lastgood xml), scfg |
| 1 | `ubi_DTB0` | 0x40000 | device tree, bank 0 |
| 2 | `ubi_k0` | 0x600000 | kernel FIT (lzma Image + fdt), bank 0 |
| 3 | `ubi_r0` | 0x4600000 (70 MiB) | squashfs rootfs, bank 0, `root=31:8` (gluebi mtdblock8) |
| 4 | `ubi_DTB1` | 0x40000 | device tree, bank 1 |
| 5 | `ubi_k1` | 0x600000 | kernel, bank 1 |
| 6 | `ubi_r1` | 0x4600000 | rootfs, bank 1, `root=31:11` |
| 7.. | (apps/framework/osgi) | | 11 user volumes in total on the factory unit |
| 120 | `rootfs_data` | free space − 8 PEBs | **NijikaWrt only**: OpenWrt overlay (UBIFS), created on first boot |

The factory unit reports 268 free PEBs (~32 MiB). NijikaWrt creates
`rootfs_data` with an explicit high volume id (120) so the gluebi mtd numbers
of the stock volumes, and therefore `root=31:8` and `root=31:11`, never shift.

## U-Boot bank selection

```
bootcmd=if itest.s ${sw_tryactive} == 2; then run boot_by_commit; else run boot_by_tryactive; fi
boot_by_commit=if itest.s ${sw_commit} == 0; then run set_act0; run b1; else run set_act1; run b2; fi
boot_by_tryactive=if itest.s ${sw_tryactive} == 0; then setenv sw_tryactive 2; setenv sw_active 0;
                  saveenv; run en_wdt; run b1; else ... sw_active 1 ... run b2; fi
en_wdt=watchdog 60
```

| variable | meaning |
|---|---|
| `sw_commit` | bank booted by default |
| `sw_active` | bank booted this time (U-Boot means to keep it in sync, see below) |
| `sw_tryactive` | `0`/`1`: boot that bank **once** with a 60 s hardware watchdog; `2`: no trial |
| `sw_version0/1` | version strings shown by the GUI (`fwu_ver`) |
| `sw_valid0/1` | bank validity flags |
| `sw_updater` | set by non-OMCI upgrades; stock `fw_loaded.sh` then commits the trial bank after a good boot |

On this board the `saveenv` inside `boot_by_tryactive` / `set_act0/1` never
reaches the flash: after a trial boot both env copies (`env`, `env2`) still
hold `sw_tryactive=<bank>` and the old `sw_active` (seen on r6 and r7). Left
alone, the trial repeats on every reboot, `fw_loaded.sh` compares against the
stale `sw_active` and commits nothing, and the stock GUI later targets the
running bank. NijikaWrt's preinit hook `03_nijika_bootenv` writes what U-Boot
meant to: `sw_tryactive=2` when the running bank is the trial bank, and
`sw_active=<running bank>` (only values that differ are written).

NijikaWrt drives these through the stock `nv` tool:

* `nijika upgrade` / sysupgrade / LuCI write the other bank and set
  `sw_updater=nijika`, `sw_tryactive=<bank>`. After the reboot, `fw_loaded.sh`
  (stock rc35, runs in the vendor chroot) commits the bank. If the new firmware
  reaches preinit but not rc35, the watchdog or a reboot brings back
  `sw_commit`. A kernel that dies before preinit keeps trial-booting (U-Boot
  cannot record the attempt), see RECOVERY.md.
* `nijika boot <n>` sets `sw_commit=sw_active=<n>`, `sw_tryactive=2`.

The kernel identifies the running bank by `root=31:8` (bank 0) or `root=31:11`
(bank 1).

## Firmware image formats

`./build.sh` produces both formats from the same `kimage`, `dtb` and rootfs.

### Factory (`*-factory.bin`), stock D-Link compatible

Plain GNU tar, same as D-Link's. The stock web GUI flashes it:

| member | |
|---|---|
| `fwu.sh` | upgrade script run by the stock web GUI: `sh fwu.sh <bank> <tar>`. Checks the running firmware is a DPN-FX3060V, never writes the running bank (from `root=`), verifies md5 and sizes against the target volumes (kernel ≤ 6 MiB) before writing, and marks `rootfs_data` for a wipe (factory install = OpenWrt defaults) |
| `dtb` | device tree → `ubi_DTB<n>` |
| `kimage` | FIT image (lzma kernel + fdt) → `ubi_k<n>` |
| `rootfs` | squashfs (xz) → `ubi_r<n>`, max 73400320 bytes |
| `fwu_ver` | version string → `sw_version<n>` |
| `hw_ver` | `skip` disables the `HW_HWVER` check |
| `md5.txt` | md5 of all members |

### Sysupgrade (`*-sysupgrade.bin`), OpenWrt

The standard OpenWrt NAND sysupgrade tar, made by the ImageBuilder's
`scripts/sysupgrade-tar.sh`, with the fwtool metadata trailer appended:

| member | written to |
|---|---|
| `sysupgrade-dlink_dpn-fx3060v-a1/CONTROL` | `BOARD=dlink_dpn-fx3060v-a1` |
| `sysupgrade-dlink_dpn-fx3060v-a1/kernel` | `ubi_k<n>` (the stock FIT `kimage`) |
| `sysupgrade-dlink_dpn-fx3060v-a1/root` | `ubi_r<n>` (squashfs, padded to 1 KiB) |
| `sysupgrade-dlink_dpn-fx3060v-a1/dtb` | `ubi_DTB<n>` |
| fwtool trailer | metadata JSON (`supported_devices: ["dlink,dpn-fx3060v-a1"]`, version) + CRC32 over the image |

sysupgrade requires the metadata (`REQUIRE_IMAGE_METADATA=1`). The CRC
replaces `md5.txt` as the integrity check, and `sw_version<n>` is set to
`<dist>_<version>` from the metadata.
