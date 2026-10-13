# NijikaWrt for the D-Link DPN-FX3060V (A1)

OpenWrt userland for the D-Link DPN-FX3060V (A1) GPON HGU, the Realtek
RTL9607DQ "Taurus" router with a built-in ONT. It runs on the
**stock Realtek 5.10.70 kernel**, and the **stock Realtek userland** keeps driving
PON, OMCI, WAN, WiFi and VoIP from the existing configuration (MIB).

```
                 _______ __ __ __ __           ________        __
                |    |  |__|__|__|  |--.---.-.|  |  |  |.----.|  |_
                |       |  |  |  |    <|  _  ||  |  |  ||   _||   _|
                |__|____|__|  |__|__|__|___._||________||__|  |____|
                           |___|     O P E N  P O N  F O U N D A T I O N

 <---------------------------------------------------------- TX 1310 nm ---
  NijikaWrt r647  |  OpenWrt 25.12.5 r33051-f5dae5ece4  |  Linux 5.10.70
  PON O5 operational  |  RX -19.7 dBm  |  TX 3.2 dBm  |  up 1h 14m
 --- RX 1490 nm ---------------------------------------------------------->
```

> **Status: stage 1, experimental.** The image builds and the LuCI app is
> tested against a mock backend. It has **not been booted on hardware
> yet**. Read [Recovery](docs/RECOVERY.md) before flashing. The A/B banks
> keep the stock firmware as a fallback.

## What you get

* **OpenWrt 25.12** userland (procd, ubus, rpcd, uhttpd, LuCI, apk, dropbear,
  htop) with a persistent overlay on a new UBI volume.
* The **stock D-Link/Realtek userland** runs untouched in a chroot at `/rtk`.
  Your existing settings (`mib`/`flash`) stay the defaults, so the router works
  like the original from the first boot.
* **boa shim**: the stock daemons expect `boa` to be alive. A shim keeps that
  contract while LuCI owns port 80. Optionally the original web GUI runs on
  port 8080.
* **LuCI "PON" menu**
  * *ONT Status*: ONU state (O1..O7), RX/TX optical power, temperature,
    voltage, bias, alarms, OLT vendor, and whether the OLT withheld ME 84/171.
  * *Quick Setup*: GPON serial, PLOAM, LOID, PPPoE WAN (VLAN, priority, MTU,
    ISP presets), WiFi 2.4/5 GHz, VoIP lines 1/2.
  * *ME Explorer*: decoded OLT provisioning (ME 131/256/84/171), a browser for
    any OMCI managed entity, read-only diag output.
  * *ONT Identity*: vendor/model/version emulation presets (from NIJIKA
    `emulate.sh`) and every identity value editable.
  * *MIB Browser*: all stock config values and chain tables, editable.
  * *Firmware Banks*: A/B bank status, try-once/make-default, flash an image to
    the other bank.
  * *Settings*: boa mode, vendor console logging, banner options.
  * A PON card on *Status → Overview*.
* **`nijika` CLI**: `info`, `olt`, `me`, `ploam`, `sn`, `loid`, `ont`,
  `mode`, `isp`, `boot`, `upgrade`, `mib`, `boa`, `reset`, `banner`. Stock
  tools are wrapped too: `diag`, `omcicli`, `flash`, `mib`, `nv`,
  `voipflashcmd`, `smuxctl`, and `rtk` opens a stock shell.
* **Animated login banner**: a grey → cyan/blue/purple sweep with live PON
  state and optical levels.

Screenshots (LuCI mock with sample data): [banner](docs/screenshots/banner.jpg),
[ONT Status](docs/screenshots/luci-ont-status.jpg),
[ME Explorer](docs/screenshots/luci-me-explorer.jpg),
[Quick Setup](docs/screenshots/luci-quick-setup.jpg).

## Hardware

| | |
|---|---|
| SoC | Realtek RTL9607DQ (Taurus, Cortina CA8277 based), 4× Cortex-A55 @ 1 GHz |
| RAM | 512 MiB DDR3 |
| Flash | 256 MiB SPI-NAND (Micron MT29F2G01), UBI |
| PON | GPON, Semtech GN25L95 BOSA |
| LAN | 4× GbE (RTL8211 PHYs), USB |
| WiFi | Realtek AX (rtw/PHL driver), 2.4 + 5 GHz |
| VoIP | 2× FXS (Si3228x) |
| Boot | ATF BL1/BL2/BL31 → U-Boot 2020.01, dual bank (`sw_commit`, `sw_tryactive`) |
| Console | ttyS0 115200 8N1 |

See [docs/FLASH_LAYOUT.md](docs/FLASH_LAYOUT.md) for the MTD/UBI layout and
the U-Boot bank logic.

## Building

Requirements (Debian/Ubuntu): `bash curl tar zstd xz-utils make fakeroot
squashfs-tools python3`. No toolchain is needed: OpenWrt comes from the
official ImageBuilder (armsr/armv8, aarch64), and the kernel and vendor stack
come from the stock firmware.

```bash
git clone <this repo> && cd dpn-fx3060v-a1-openwrt
cp /path/to/DPN-FX3060V_V1.1.2_20231108_1050_XSTP.bin stock/
./build.sh
```

`bin/` then holds two images built from the same kernel, dtb and rootfs
(about 28 MB each; the rootfs is about 24 MB of the 70 MB available), plus
`sha256sums`:

| Image | Format | Flash with |
|---|---|---|
| `NijikaWrt-r<N>-25.12.5-dlink_dpn-fx3060v-a1-factory.bin` | stock D-Link tar: `fwu.sh dtb kimage rootfs fwu_ver hw_ver md5.txt` | the **stock D-Link web GUI** (first install) |
| `NijikaWrt-r<N>-25.12.5-dlink_dpn-fx3060v-a1-sysupgrade.bin` | OpenWrt NAND sysupgrade tar: `sysupgrade-dlink_dpn-fx3060v-a1/{CONTROL,kernel,root,dtb}` + fwtool metadata | **NijikaWrt**: `sysupgrade`, LuCI, `nijika upgrade` |

Steps can be run on their own: `./build.sh fetch stock rootfs assemble
firmware`, plus `clean` and `distclean`. Versions, branding and the package
selection live in [`build.conf`](build.conf).

D-Link's firmware is not redistributable and is never committed. The build
reuses its `kimage`, `dtb` and `rootfs`.

## Flashing

Either image always goes to the **inactive** bank; the running firmware is
never overwritten.

* **First install, from stock firmware: `-factory.bin`.** Use *Management →
  Upgrade Firmware* in the D-Link web GUI. The stock `boa` runs our `fwu.sh`,
  which checks md5 and writes `ubi_{DTB,k,r}<n>`. The stock GUI rejects the
  sysupgrade image because it has no `fwu.sh`.
* **Updates, from NijikaWrt: `-sysupgrade.bin`.** Use `sysupgrade -v
  <file>` (add `-n` to drop settings), LuCI *System → Backup / Flash Firmware*,
  LuCI *PON → Firmware Banks*, or `nijika upgrade <file>`. sysupgrade checks the
  board (`dlink,dpn-fx3060v-a1`) and the image CRC from the fwtool metadata. By
  default the new bank is tried once (U-Boot arms a 60 s watchdog) and committed
  after a good boot; otherwise the router falls back to the previous bank.
  OpenWrt settings are kept unless `-n` is given.
* **Back to stock:** `nijika boot <bank>` if a bank still has D-Link firmware.
  You can also flash the D-Link `.bin` through *PON → Firmware Banks* or
  `nijika upgrade`. With `sysupgrade`/LuCI *Flash Firmware* you must force it
  (`sysupgrade -F -n DPN-FX3060V_….bin`, or the "Force" checkbox), because a
  stock image carries no board metadata.

First boot:

* The UBI volume `rootfs_data` is created from free space (about 30 MiB) for the
  OpenWrt overlay. A factory flash from the stock GUI resets it, so every
  factory install starts with OpenWrt defaults; sysupgrade keeps settings.
* LuCI: `http://192.168.0.1/` (the LAN IP from the stock config). Same as
  stock OpenWrt: user `root` with **no password**. LuCI shows "No password
  set!"; set one under *System → Administration* (or `passwd` on the shell).
  The stock D-Link accounts (`tmadmin`, …) only apply to the stock GUI on port
  8080 (`nijika boa stock`).
* SSH: `ssh root@192.168.0.1`. Serial console (ttyS0): press Enter for a root
  shell; no login, like OpenWrt (`system.@system[0].ttylogin=0`).

## How it works

```
 ┌────────────────────────── OpenWrt 25.12 (musl) ───────────────────────────┐
 │ procd · ubus · rpcd · uhttpd/LuCI · dropbear · apk · logd · nijika-ontd   │
 │                                                                           │
 │  /usr/bin/{mib,flash,diag,omcicli,nv,...} ──► chroot /rtk                 │
 │  rpcd "nijika" ──► nijika CLI ──► same wrappers                           │
 │                                                                           │
 │   ┌──────────────── /rtk : stock D-Link rootfs (glibc 2.30) ───────────┐  │
 │   │ configd · startup · systemd(rtk) · omci_app · spppd · dnsmasq ·    │  │
 │   │ hostapd · VoIP · boa → shim (or boa.stock on :8080)                │  │
 │   │ /var = own tmpfs, /var/config = UBI ubi_Config (stock MIB)         │  │
 │   └────────────────────────────────────────────────────────────────────┘  │
 └───────────────────────────────────────────────────────────────────────────┘
   stock kernel 5.10.70 + Realtek modules (PON, NIC, WiFi, VoIP, flow engine)
```

Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): boot sequence,
chroot mounts, patched stock rc lines, path mirrors, the boa shim, the
sysupgrade A/B flow and the overlay handling.

## The `nijika` command

```
nijika info [--json|--short|--live]   ONU state, RX/TX dBm, temperature, OLT vendor
nijika olt [--json]                   OLT provisioning: ME 131 / 256 / 84 / 171
nijika me <id|name> [--json]          any managed entity: olt ont ani uni vlan extvlan veip gem tcont ...
nijika ploam [password]               show/set PLOAM password
nijika sn [DLKIxxxxxxxx]              show/set GPON serial
nijika loid [id [password]]           show/set LOID
nijika ont [preset|factory]           ONT identity emulation (Huawei, Nokia, Skyworth, D-Link, NIJIKA)
nijika mode [hgu|sfu1|sfu2|compat|manage|factory]   OMCI_CUSTOM_* VLAN handling
nijika isp [unifi|maxis|time|...]     ISP VLAN/priority/MTU preset for the Internet WAN
nijika boot [status|0|1|toggle|try N] firmware bank selection
nijika upgrade [--commit] <fw.bin>    write firmware to the other bank
nijika mib get|set|def|all|chain      stock configuration database
nijika boa [shim|stock]               boa shim or stock GUI on :8080
nijika reset [--all]                  factory reset, keeps serial/PLOAM/MAC
nijika banner | version | rtk [cmd]
```

## Configuration (`/etc/config/nijika`)

| Option | Default | |
|---|---|---|
| `vendor.boa` | `shim` | `stock` runs the D-Link web GUI on port 8080 |
| `vendor.console` | `1` | stock boot output on ttyS0 (`0` sends it to `logread -e rtk`) |
| `vendor.inetd` | `0` | stock telnet (port 23) |
| `vendor.lan_mgmt` | `1` | keep TCP 22/80 open on `br0` in the stock iptables |
| `banner.animate` | `ssh` | `always`, `ssh`, `never` (serial at 115200 is slow) |
| `banner.color` | `auto` | `truecolor`, `256`, `16`, `none` |
| `ontd.interval` | `5` | PON status cache refresh in seconds |

## Development

* `tools/banner-preview.sh`: render the login banner on a PC
  (`COLOR=truecolor STATE=O3 RX=-28.4 tools/banner-preview.sh`).
* `tools/luci-mock/server.py`: run the LuCI app in a browser against
  synthetic data (after `./build.sh rootfs assemble`).
* `tools/probe.sh`: **read-only** script for the router. It records the exact
  `diag`/`omcicli`/`flash`/`voipflashcmd` output formats and the layout NijikaWrt
  relies on. Secrets are redacted by default.
* `package/` is also an OpenWrt feed (Makefiles), so the packages can be built as
  `.apk` with the OpenWrt SDK.

## Known limitations (stage 1)

* The kernel is the stock 5.10.70 build: no nftables (`fw4`), TUN/WireGuard,
  mac80211 or kmods from OpenWrt. Firewall, NAT, PPPoE, DHCP and WiFi are done
  by the stock stack, and LuCI's *Network* pages are intentionally not installed.
* Values written via Quick Setup/MIB are applied by the stock stack after a
  reboot.
* The output parsers (transceiver units, ME 171 rule lines, `flash get
  <chain>` format) follow the stock binaries' format strings and need
  confirmation from `tools/probe.sh` output on real hardware.
* Kernel threads of the stock drivers resolve paths against the OpenWrt root.
  `/lib/firmware`, `/etc/serdes`, `/etc/conf`, `/config` and `/var/*` are
  mirrored into `/rtk`. If a driver complains about a missing file, that's the
  first place to look.

## Credits

* Anime4000: NIJIKA firmware and the [RTL960x](https://github.com/Anime4000/RTL960x) project
* OpenWrt and LuCI projects
* Realtek / D-Link for the stock firmware this builds upon (not included)
