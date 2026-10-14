# D-Link DPN-FX3060V (A1): hardware notes

Facts measured on the test unit with stock firmware `DPN-FX3060V_V1.1.2`
(2023-11-08) and NijikaWrt. They back the values in `device.conf`.

## SoC and boot

| | |
|---|---|
| SoC | Realtek RTL9607DQ "Taurus", Cortex-A55 1 GHz, Cortina NI/switch (`ca_ne`) |
| Device tree | `model = "Realtek Taurus ENG Board"`, `compatible = "realtek,taurus"` (same string on every Taurus board: not usable to tell revisions apart) |
| RAM | 512 MiB DDR3 |
| Flash | 256 MiB SPI-NAND (MT29F2G01 / F50L2G41XA / XT26G02E / WSFVC32GBID), UBI on mtd `ubi_device` |
| Boot | ATF BL1/BL2/BL31, U-Boot 2020.01, A/B banks (see docs/FLASH_LAYOUT.md) |
| Kernel | stock Realtek 5.10.70, FIT image with the DTB; no `CONFIG_BONDING`, no nftables, no TUN |

## Ethernet

| switch port | front port | Linux | PHY ID (page 0 reg 2/3) |
|---|---|---|---|
| 0 | LAN1 | `eth0.2` | `0x001C 0xCAC4` (internal GbE PHY) |
| 1 | LAN2 | `eth0.3` | `0x001C 0xCAC4` |
| 2 | LAN3 | `eth0.4` | `0x001C 0xCAC4` |
| 3 | LAN4 | `eth0.5` | `0x001C 0xCAC4` |
| 4-6 | - | | `0xFFFF 0xFFFF` (no PHY) |

* All LAN ports are 1000BASE-T. The CPU port (`eth0`) is 1 Gbit/s; LAN ports
  reach the CPU as port-tagged VLAN interfaces (`eth0.2`..`eth0.5`) bridged in
  `br0` by the stock stack.
* The port mapping is from link state (`diag rt_port get status port all`
  against the cable in use); confirm with one cable per port when needed.
* No hardware trunking: `diag trunk ...` answers "driver is not found" and the
  `rt_*` API has no trunk call. The stock "LACP" page (`lacp.asp`,
  `LACP_ENABLE`) belongs to D-Link's Ethernet-WAN builds and is compiled out.

## PON

* GPON, Semtech GN25L95 BOSA, DDM over I2C (`diag pon get transceiver ...`).
* GPON state and flows: `diag rt_gpon ...` (the older `diag gpon ...` tree
  reports "driver not found"). No alarm read-out.
* OMCI: stock `omci_app` + `omcicli` (see docs/ARCHITECTURE.md for its limits).

## Revisions

* **B1** (not supported yet): 2.5GbE port through a Realtek RTL8221B PHY
  (PHY ID `0x001CC849`), stock firmware V2.x (the `dpn-fx3060v` ONT identity
  preset reports hardware `B1`, software `V2.0.6`). Expect a different device
  tree, a different `DEVICE_PHY_IDS`, and possibly different UBI sizes. See
  docs/PORTING.md.
