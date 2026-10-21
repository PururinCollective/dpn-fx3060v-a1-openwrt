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
                                            ft. DPN-FX3060V (A1)

 <---------------------------------------------------------- TX 1310 nm ---
  NijikaWrt r29  |  OpenWrt 25.12.5 r33051-f5dae5ece4  |  Linux 5.10.70
  PON O5.1 operational  |  RX -14.13 dBm  |  TX 2.61 dBm  |  up 4m
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
* **No vendor cloud agent**: D-Link's Alibaba Cloud IoT agent (`ccom_linkkit`:
  cloud firmware/config push, remote control) is removed from the image.
* **Stock boa kept, but hidden**: the stock stack needs the real `boa` (it starts
  the VoIP configuration server, among others). It runs on ports 8080/443 and is
  firewalled to the router itself unless you set `nijika boa lan`; LuCI owns
  port 80.
* **DNS over HTTPS** for the LAN and the router, on by default with
  `https://b.hitoha.moe/dns-query`. The stock DNS server keeps serving the LAN
  and sends every lookup to a local `https-dns-proxy`, except the ISP's own
  domains (voice/IMS, TR-069), so phone and remote management keep working.
* **Dynamic DNS** (Services > DDNS) in place of the stock client: the stock
  list (DynDNS, No-IP, ChangeIP, GnuDIP, Dynu, FreeDNS; DtDNS closed in 2018)
  plus freedns.afraid.org by update URL and Cloudflare (e-mail + global API
  key like ddclient, or an API token; several hosts per zone). IPv4 only,
  over HTTPS. The WAN's own address (`ppp0`) is published when it is public;
  behind carrier-grade NAT (100.64.0.0/10) or another private/reserved range
  the address the internet sees comes from a lookup service
  (`ip1.dynupdate.no-ip.com` first) and the page warns that it is shared and
  recommends IPv6. The stock `updatedd` does not run (it would publish
  100.64.x.x over plain HTTP).
* **WireGuard** (Services > WireGuard): interface `wg0` for phones, laptops
  and site-to-site links, though the stock kernel has none: NijikaWrt builds
  the module and its crypto libraries (NEON ChaCha20/Poly1305) for the stock
  5.10.70 kernel ([Kernel modules](#kernel-modules-for-the-stock-kernel)).
  Peers get the access of a LAN device (router, LAN, internet through the
  WAN); the port and the tunnel are opened in the stock firewall. A new peer
  gets a key pair, preshared key and the next free address, and its client
  configuration as a QR code; the endpoint is the DDNS name, else the WAN
  address, else (CGNAT) an IPv6 address of the router.
* **Stock SPI firewall off**: the stock GUI's *SPI Firewall* switches (IPv4 and
  IPv6, incoming and outgoing) are set to off at every boot, so a wrong toggle
  can no longer cut the LAN off. NAT still keeps unsolicited IPv4 out; on IPv6
  every LAN device with a public address is reachable, its own firewall is what
  protects it (`firewall.spi_ipv6 on` restores the stock behaviour).
* **Stock GUI pages in LuCI**:
  * Network > PON WAN: the stock WAN connections as `PON_<n>`. Channel mode
    (Bridged, IPoE, DHCP, PPPoE, DS-Lite, 6rd), VLAN, NAT, PPPoE,
    IPv4/IPv6, port mapping (untagged) and VLAN tagging (LAN ports carrying
    the connection's VLAN tagged, so several bridged connections can share
    a port like a managed switch trunk); delete.
  * Network > LAN: address, ports, IGMP snooping, DHCP server; the page
    reloads after saving.
  * Network > Port Forwarding and DMZ: the stock rules (table size as the
    stock configuration has it, UPnP rules shown read-only), DMZ host.
  * Network > Wireless: a tab per radio (mode incl. "no 802.11b" and
    "802.11ax only", channel, width, TX power, OFDMA, beacon/DTIM, WMM),
    main and guest SSIDs (WPA2/WPA3, PMF, 802.11r/k/v), WPS (push button,
    PIN), and EasyMesh (role, backhaul, pairing). The role is pinned at boot
    (`nijika.vendor.easymesh`, default controller): D-Link/TM's "auto" turns
    the unit into a mesh node when the WPS button is pressed without fibre
    (LAN DHCP client, no DHCP server), which only suits a spare unit.
  * Services > VoIP: SIP accounts of both phone ports (a tab each), primary
    and backup proxy.
  * Services > DDNS: see above; status per entry, *Update now*.
  * Services > WireGuard: see above; handshakes and traffic per peer.
  * PON > Authentication: LOID, PLOAM, device type, OLT mode.
* **Status > Overview**: System, then PON / ONT (the fibre link drawn as
  OLT ⇄ NijikaWrt with live 1490/1310 nm light, RX/TX power, WAN address),
  then the WAN connections (VLAN, type, protocol, address, gateway, state)
  like the stock Device Status page.
* **Perfect theme** (the default LuCI theme): the look of
  [Perfect](https://perfect.my/) - blue header and footer, lime buttons with
  hard shadows, the Inter font, the Perfect logo, and the Perfect cat on the
  login page. Bootstrap is still there: System > System > Language and Style.
  A theme picked there is kept across upgrades.
* **ISP management off**: the stock TR-069 client and SNMP agent do not run
  under NijikaWrt (Nijika > Settings turns them back on), so the ISP's ACS
  cannot reconfigure the stock stack behind OpenWrt's back. The TR-069 WAN
  connection still comes up; the stock settings, which the stock bank uses,
  are untouched.
* **WiFi 6 defaults**: at first boot OFDMA is turned on, 802.11r on the main
  SSIDs (FT-PSK and FT-SAE, WPA3 included) and 2.4 GHz drops 802.11b
  (g/n/ax). Once; later changes stay. Band steering (prefer 5 GHz) follows
  the SSIDs: on whenever both bands share name and password. BSS colouring,
  which the stock firmware leaves off, is on per radio; TWT is not
  available (the stock driver does not support it). What the WiFi stack can
  and cannot do: [docs/WIFI.md](docs/WIFI.md).
* **Clean reboot**: like the stock firmware, a reboot (and sysupgrade) first
  ends the PPPoE sessions (LCP Terminate + PADT) and releases DHCP leases, so
  the ISP accepts the next login at once, and writes the stock
  configuration still held in RAM to flash.
* **Live apply, like the stock GUI**: a change to the WAN, firewall, LAN,
  WiFi, GPON registration or VoIP takes effect right away. `rtk-apply` makes
  the same libmib calls the stock web forms make after "Apply"
  ([docs/BOA.md](docs/BOA.md)); only a few keys (GPON serial, ONT identity)
  still need a reboot.
* **The stock configuration as UCI**: `/etc/config/rtk` mirrors the flash MIB
  (`uci get rtk.mib.LAN_IP_ADDR`, `uci get rtk.ATM_VC_TBL_0.vid`); a commit plus
  `reload_config` (or LuCI "Save & Apply") writes the changed options back
  with `flash set`.
* **Quick Setup** (top menu, next to Log out): GPON serial, PLOAM, LOID,
  PPPoE WAN (VLAN, priority, MTU, ISP presets), WiFi 2.4/5 GHz, VoIP lines 1/2.
* **LuCI "PON" menu**
  * *Authentication*: LOID, PLOAM password, device type, OMCI OLT mode (the
    stock GPON Settings page).
  * *ONT Identity* (shown with Nijika > Settings > Developer options):
    vendor/model/version emulation presets (from NIJIKA `emulate.sh`) and
    every identity value editable.
  * *ONT Status*: ONU state (O1..O7), RX/TX optical power, temperature,
    voltage, bias, alarms, and the OMCI provisioning: ME 131 OLT-G, ME 256
    ONT-G, ME 84 VLAN filters, ME 171 extended VLAN rules.
  * *OLT Provision*: the OMCI configuration received from the OLT: service
    flows (VLAN path, ONT action, stock WAN), ME 171 rules, the ME topology
    from T-CONT to UNI / VEIP, and upstream QoS (GEM port -> queue -> T-CONT /
    Alloc-ID). `tools/omci-capture.sh` saves the same data for a bug report.
  * A PON card on *Status → Overview*.
* **LuCI "Nijika" menu**
  * *Settings*: boa mode, live apply, vendor console logging, stock SPI
    firewall, DNS over HTTPS, banner options, developer options.
  * *Firmware Banks*: A/B bank status, try-once/make-default, flash an image to
    the other bank.
  * *MIB Browser*: all stock config values and chain tables, editable.
* **`nijika` CLI**: `info`, `olt`, `me`, `ploam`, `sn`, `loid`, `ont`,
  `mode`, `isp`, `boot`, `upgrade`, `mib`, `boa`, `reset`, `banner`. Stock
  tools are wrapped too: `diag`, `omcicli`, `flash`, `mib`, `nv`,
  `voipflashcmd`, `smuxctl`, `iptables`/`ip6tables`/`ebtables` (the stock
  firewall), and `rtk` opens a stock shell.
* **Animated login banner**: the NijikaWrt logo, "ft. <model>" and the project
  links, lit by a grey → cyan/blue/purple sweep. The two rules are the ONT's
  lights: the downstream light (RX 1490 nm) flows in as a wave, then the laser
  (TX 1310 nm) sends bursts out, as GPON does. Each rule is red only while that
  light really exists (live reading above −35 dBm) and grey otherwise, so the
  banner never lies about the fibre. Over SSH only by default (~1.2 s); the
  serial console gets the static version. Links: `/usr/share/nijika/banner-links`.

Screenshots (LuCI mock with sample data): [banner](docs/screenshots/banner.jpg),
[ONT Status](docs/screenshots/luci-ont-status.jpg),
[Quick Setup](docs/screenshots/luci-quick-setup.jpg).

## Hardware

| | |
|---|---|
| SoC | Realtek RTL9607DQ (Taurus, Cortina CA8277 based), 4× Cortex-A55 @ 1 GHz |
| RAM | 512 MiB DDR3 |
| Flash | 256 MiB SPI-NAND (MT29F2G01 / F50L2G41XA / XT26G02E / WSFVC32GBID), UBI |
| PON | GPON, Semtech GN25L95 BOSA |
| LAN | 4× GbE (internal PHYs on switch ports 0–3), USB |
| WiFi | Realtek AX (rtw/PHL driver), 2.4 + 5 GHz |
| VoIP | 2× FXS (Si3228x) |
| Boot | ATF BL1/BL2/BL31 → U-Boot 2020.01, dual bank (`sw_commit`, `sw_tryactive`) |
| Console | ttyS0 115200 8N1 |

See [docs/FLASH_LAYOUT.md](docs/FLASH_LAYOUT.md) for the MTD/UBI layout and
the U-Boot bank logic.

### Hardware revisions

| Revision | | Profile |
|---|---|---|
| A1 | 4× GbE, stock firmware V1.x: supported and tested | `devices/dpn-fx3060v-a1` |
| B1 | 2.5GbE port (RTL8221B), stock firmware V2.x: supported and tested | `devices/dpn-fx3060v-b1` |

Images are built per revision (`DEVICE=` in `build.conf`) because they carry
that revision's stock kernel and device tree. The installers compare the
switch PHY IDs of the unit with the image's profile and refuse a mismatch
(`touch /tmp/nijika_force` overrides); `nijika hw` shows both.

## Building

Requirements (Debian/Ubuntu): `bash curl tar zstd xz-utils make fakeroot
squashfs-tools python3` and [uv](https://docs.astral.sh/uv/) (or a `zig`
binary, see `ZIG` in `build.conf`). OpenWrt comes from the official
ImageBuilder (armsr/armv8, aarch64), and the kernel and vendor stack come
from the stock firmware. The only compiled part is the small `rtk-apply`
helper ([docs/BOA.md](docs/BOA.md)): `zig cc` builds it for the stock glibc
2.30; uv fetches zig 0.15.2 from PyPI (about 90 MB, once) on first use.

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

Steps can be run on their own: `./build.sh fetch stock kmod rootfs assemble
firmware`, plus `clean` and `distclean`. Versions, branding and the package
selection live in [`build.conf`](build.conf).

### Kernel modules for the stock kernel

The stock 5.10.70 kernel has no WireGuard and no CAKE qdisc. `./build.sh
kmod` ([scripts/build-kmod.sh](scripts/build-kmod.sh)) builds them as
modules, with the crypto libraries WireGuard selects, so that the stock
kernel loads them:

* **Source**: the kernel tree of the Realtek Luna SDK, which D-Link's kernel
  is built from. Point `KERNEL_SDK` at its `rtl819x` directory (default
  `/media/realtek/root/SDK/rtl819x`, e.g. the SDK VM's disk mounted with
  `guestmount -a <disk> -i --ro /media/realtek`). It is needed once: the
  prepared tree is kept as `dl/linux-5.10.70-rtk.tar.zst`. Without it the
  step is skipped and the image has no WireGuard and no CAKE.
* **Config**: the stock kernel's own (`IKCONFIG` from the stock `kimage`)
  plus `KMOD_CONFIG` as modules; the step stops if anything built into the
  kernel would change.
* **Compiler**: gcc 10.2 like the stock kernel's (Realtek ASDK64 10.2.0):
  Bootlin's `aarch64--glibc--bleeding-edge-2020.08-1` toolchain,
  downloaded once (127 MB, sha256 in `build.conf`). Extra host tools: `perl
  bc rsync`.
* **Checks**: `modpost` resolves every symbol against the stock kernel's
  exports ([scripts/ksymtab.py](scripts/ksymtab.py) reads them from its
  `__ksymtab`), and the vermagic must equal the stock modules'.
* **In the image**: `/usr/lib/nijika/kmod/5.10.70/` with `modules.load`
  (all of them, dependencies first) and a load list per feature,
  `wireguard.load` and `sch_cake.load`, so a feature loads only its own
  modules.

The tree, config and compiler reproduce the stock kernel's ABI: stock
modules built from the same sources (`nf_conntrack_ftp/tftp/pptp`,
`nf_nat_ftp`, Realtek's `ebt_mark2`/`xt_mark2`/`xt_connmark2`) come out
instruction for instruction identical to D-Link's, `cfg80211` except for
D-Link's own WiFi changes.

D-Link's firmware is not redistributable and is never committed. The build
reuses its `kimage`, `dtb` and `rootfs`.

## Flashing

Either image always goes to the **inactive** bank; the running firmware is
never overwritten.

* **First install, from stock firmware: `-factory.bin`.** Use *Management →
  Upgrade Firmware* in the D-Link web GUI. The stock `boa` runs our `fwu.sh`,
  which checks md5 and writes `ubi_{DTB,k,r}<n>`. The stock GUI rejects the
  sysupgrade image because it has no `fwu.sh`.
* **Keeping stock + NijikaWrt side by side (recommended): update from the stock
  bank with `-factory.bin`.** There are only two banks. Boot the stock bank
  (`nijika boot <stock bank>`), then upload the new `-factory.bin` in the stock
  GUI. It replaces the old NijikaWrt in the other bank, and OpenWrt settings
  start fresh.
* **Updates from NijikaWrt: `-sysupgrade.bin`** (sysupgrade, LuCI *System →
  Backup / Flash Firmware* or *Nijika → Firmware Banks*, `nijika upgrade`) always
  write the **other** bank. If that bank holds the stock D-Link firmware, they
  **refuse**, so stock is never lost by accident. Override with `sysupgrade -F`,
  `nijika upgrade --replace-stock`, or the confirmation tick box in LuCI. With
  NijikaWrt in both banks this is a normal A/B update. sysupgrade checks the
  board (`dlink,dpn-fx3060v-a1`) and the image CRC from the fwtool metadata. The
  new bank is tried once (60 s U-Boot watchdog) and committed after a good boot;
  OpenWrt settings are kept unless `-n` is given.
* **Back to stock:** `nijika boot <bank>` if a bank still has D-Link firmware.
  You can also flash the D-Link `.bin` through *Nijika → Firmware Banks* or
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
  8080 and HTTPS 443 (router-only by default; `nijika boa lan` opens it to the LAN).
* SSH: `ssh root@192.168.0.1`. Serial console (ttyS0): press Enter for a root
  shell; no login, like OpenWrt (`system.@system[0].ttylogin=0`).

## How it works

```
 ┌────────────────────────── OpenWrt 25.12 (musl) ───────────────────────────┐
 │ procd · ubus · rpcd · uhttpd/LuCI · dropbear · apk · logd · housekeep    │
 │                                                                           │
 │  /usr/bin/{mib,flash,diag,omcicli,nv,...} ──► chroot /rtk                 │
 │  rpcd "nijika" ──► nijika CLI ──► same wrappers                           │
 │                                                                           │
 │   ┌──────────────── /rtk : stock D-Link rootfs (glibc 2.30) ───────────┐  │
 │   │ configd · startup · systemd(rtk) · omci_app · spppd · dnsmasq ·    │  │
 │   │ hostapd · VoIP · boa (:8080, firewalled to localhost)            │  │
 │   │ /var = own tmpfs, /var/config = UBI ubi_Config (stock MIB)         │  │
 │   └────────────────────────────────────────────────────────────────────┘  │
 └───────────────────────────────────────────────────────────────────────────┘
   stock kernel 5.10.70 + Realtek modules (PON, NIC, WiFi, VoIP, flow engine)
```

Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): boot sequence,
chroot mounts, patched stock rc lines, path mirrors, why boa must run, the
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
nijika boa [hidden|lan]               stock D-Link GUI on :8080: router-only or LAN
nijika doh [on|off|url <URL>]         DNS over HTTPS status / switch / resolver
nijika uci [sync|diff]                /etc/config/rtk against the stock flash
nijika apply wan [n]|firewall|lan|wlan|voip|gpon   apply the stock config to the running stack
nijika wan [list|delete <#>]          stock WAN connections (PON_<n>); delete one
nijika reset [--all]                  factory reset, keeps serial/PLOAM/MAC
nijika banner | version | rtk [cmd]
```

## Configuration (`/etc/config/nijika`)

| Option | Default | |
|---|---|---|
| `vendor.boa` | `hidden` | stock D-Link GUI (always running on :8080): `hidden` = router only, `lan` = LAN too |
| `vendor.console` | `1` | stock boot output on ttyS0 (`0` sends it to `logread -e rtk`) |
| `vendor.stock_log` | `5` | syslog of the stock services passed to `logread` up to this level (`5` notice = what the stock firmware keeps; `6`/`7` add the VoIP stack's chatter); next boot |
| `vendor.inetd` | `0` | stock telnet (port 23) |
| `vendor.lan_mgmt` | `1` | keep TCP 22/80 open on `br0` in the stock iptables |
| `vendor.live_apply` | `1` | apply stock config changes to the running stack like the stock GUI ([docs/BOA.md](docs/BOA.md)); `0`: wait for a reboot |
| `banner.animate` | `ssh` | `always`, `ssh`, `never` (serial at 115200 is slow) |
| `banner.color` | `auto` | `truecolor`, `256`, `16`, `none` |
| `pon.cache_ttl` | `5` | PON status is read on demand (LuCI, `nijika info`, banner) and reused this many seconds |
| `doh.enabled` | `1` | DNS over HTTPS for the LAN and the router |
| `doh.resolver_url` | `https://b.hitoha.moe/dns-query` | RFC 8484 resolver |
| `doh.bootstrap_dns` | `1.1.1.1,8.8.8.8` | plain DNS used only to look up the resolver's host name |
| `doh.listen_port` | `5053` | local port of the proxy (127.0.0.1) |
| `ddns.enabled` | `1` | dynamic DNS (Services > DDNS) for the enabled `ddns_host` entries |
| `ddns.interface` | `auto` | WAN whose address is published: `auto` = the default route's (`ppp0`), or an interface name |
| `ddns.ip_url` | `http://ip1.dynupdate.no-ip.com/`, `https://api.ipify.org/`, `https://ipv4.icanhazip.com/` | where the public address is asked when the WAN's is not public (CGNAT, private, reserved) |
| `ddns.check_interval` | `600` | seconds between those lookups (the WAN itself is checked every minute) |
| `ddns.force_interval` | `86400` | an unchanged address is sent again after this many seconds |
| `wireguard.enabled` | `0` | WireGuard interface `wg0` (Services > WireGuard); peers in `wireguard_peer` sections |
| `wireguard.listen_port` | `51820` | UDP port, opened in the stock firewall (IPv4 and IPv6) |
| `wireguard.address` | `10.7.0.1/24` | the router's tunnel address(es) and subnet |
| `wireguard.private_key` | generated | at the first start when not set |
| `wireguard.mtu` | WAN MTU - 80 | 1412 with PPPoE |
| `wireguard.endpoint` | automatic | address in client configurations: the first DDNS host name, else the WAN's public IPv4, else an IPv6 address of the router |
| `wireguard.dns` | LAN address | DNS server in client configurations |
| `uci.tables` | `ATM_VC_TBL WLAN_MBSSIB_TBL WLAN1_MBSSIB_TBL` | chain tables mirrored into `/etc/config/rtk` |
| `firewall.spi_ipv4` | `off` | stock *IPv4 SPI Firewall*, pinned at boot: `off` (allow both ways), `on` (stock: drop new incoming), `keep` (whatever the stock GUI set) |
| `firewall.spi_ipv6` | `off` | the same for IPv6 (`off`: LAN devices reachable over IPv6) |
| `firewall.wan_ping` | `1` | answer ping from the internet (IPv4/IPv6, max 10/s): the stock remote access settings drop it; path MTU checks from outside need it |

## The stock configuration as UCI (`/etc/config/rtk`)

```
uci get rtk.mib.LAN_IP_ADDR             # any scalar of `flash all`
uci get rtk.ATM_VC_TBL_0.vid            # record 0 of a chain table
uci set rtk.WLAN_MBSSIB_TBL_0.ssid='My WiFi'
uci commit rtk && reload_config         # -> flash set WLAN_MBSSIB_TBL.0.ssid ...
nijika uci diff                         # what the next sync would write
```

The file is rebuilt from flash after boot, every 10 minutes and after each
apply: an option missing from UCI is filled in with its flash value, and
`uci delete` brings the flash value back. Only options changed in UCI since the
last sync are written, so a value the stock web GUI or TR-069 changed in the
meantime is not overwritten. Written options are applied to the running stack
the way the stock web form for them does ([docs/BOA.md](docs/BOA.md));
`nijika uci diff` also shows which. The file holds the same secrets as
the stock configuration (PPPoE, WiFi keys) and is readable by root only.

## Development

* `tools/banner-preview.sh`: render the login banner on a PC
  (`COLOR=truecolor STATE=O3 RX=-28.4 tools/banner-preview.sh`; no fibre:
  `STATE=O1.1 LOS=1 RX=-inf TX=-inf`, no reading yet: `NODATA=1`).
* `tools/luci-mock/server.py`: run the LuCI app in a browser against
  synthetic data (after `./build.sh rootfs assemble`). Pages use the Perfect
  theme (`LUCI_THEME=bootstrap` for Bootstrap), `/cgi-bin/luci/login` is the
  login page, and `package/*/htdocs` is served live, so edits need no rebuild.
* `tests/run.sh`: offline regression suite (about 20 s, no router): shell
  syntax, JSON, lint rules, the parsers against real captures, the stock
  dnsmasq wrapper, `/etc/config/rtk` quoting, the boot-env hook, every factory
  installer scenario, the banner, the theme defaults. Run it before every image.
* `tools/fwu-dryrun.sh`: runs the factory installer shipped in the image on a
  PC against stubbed stock tools through eleven upgrade situations (fresh
  install, reinstall, U-Boot env out of sync, corrupt upload, wrong device,
  oversized rootfs, unknown running bank, env not writable, other hardware
  revision, other revision's stock firmware, PHY IDs unreadable).
* `tools/probe.sh`: **read-only** script for the router (stock or NijikaWrt).
  It records the exact `diag`/`omcicli`/`flash`/`voipflashcmd` output formats,
  the layout NijikaWrt relies on and the hardware facts a device profile needs
  (switch PHY IDs, port status, kernel options). Secrets are redacted by default.
* `tools/omci-capture.sh`: OMCI baseline (every data-path ME class, the queue
  map, the connections) from a unit on live fibre, credentials masked.
* [docs/PORTING.md](docs/PORTING.md): bringing up another hardware revision,
  and the list of pitfalls found on A1.
* `package/` is also an OpenWrt feed (Makefiles), so the packages can be built as
  `.apk` with the OpenWrt SDK.

## Known limitations (stage 1)

* The kernel is the stock 5.10.70 build: no nftables (`fw4`), TUN, mac80211
  or kmods from OpenWrt (WireGuard and CAKE are built for it, see above). Firewall, NAT,
  PPPoE, DHCP and WiFi are done by the stock stack, and LuCI's *Network*
  pages are intentionally not installed.
* Values written via Quick Setup/MIB are applied by the stock stack after a
  reboot.
* No link aggregation: the stock kernel has no bonding and this SoC's switch
  driver no trunking (details in `devices/dpn-fx3060v-a1/NOTES.md`).
* Kernel threads of the stock drivers resolve paths against the OpenWrt root.
  `/lib/firmware`, `/etc/serdes`, `/etc/conf`, `/config` and `/var/*` are
  mirrored into `/rtk`. If a driver complains about a missing file, that's the
  first place to look.

## Credits

* Anime4000: NIJIKA firmware and the [RTL960x](https://github.com/Anime4000/RTL960x) project
* OpenWrt and LuCI projects
* Perfect (perfect.my): logo, colours and cat artwork used by the Perfect theme
* The Inter Project Authors: the Inter font (SIL Open Font License 1.1)
* Realtek / D-Link for the stock firmware this builds upon (not included)
