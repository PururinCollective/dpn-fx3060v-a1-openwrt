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
Everything runs with the environment the stock busybox init provides
(`PATH=/sbin:/usr/sbin:/bin:/usr/bin:/etc/scripts`, `HOME=/`, `SHELL`,
`USER`). Without `/etc/scripts`, stock rc35's `fw_loaded.sh` (which commits a
trial-booted bank) and the WiFi tuning helpers `cmd`/`cmd1` are not found.

```
/                     OpenWrt squashfs + overlay (UBI rootfs_data)
├── rtk/              stock D-Link rootfs (from the stock firmware at build time)
│   ├── proc sys dev  mounted/bind-mounted by /etc/init.d/rtk-vendor
│   ├── var           own tmpfs (stock rc2 used a ramfs)
│   │   └── config    UBIFS ubi_Config, mounted by stock rc2: the MIB
│   ├── run           tmpfs
│   ├── bin/boa       stock boa on port 8080 (firewalled, see below)
│   └── etc/nijika/   patched copy of the stock rc chain
├── lib/firmware  ──► /rtk/lib/firmware   (kernel firmware loader)
├── etc/serdes    ──► /rtk/etc/serdes     (ca-pon SerDes tables)
├── etc/conf      ──► /rtk/etc/conf       (compat.ko, cfg80211.ko)
├── config        ──► /rtk/var/config     (scfg.txt)
└── tmp/<x>       ──► /rtk/var/<x>        (var-mirror; never overrides host entries)
```

The mirrors exist because kernel threads (workqueues of the stock drivers)
resolve file paths against the root of PID 1, not the chroot.

## Device profiles

`devices/<id>/device.conf` holds what differs between hardware revisions
(board name, model, stock firmware pattern, switch PHY ID fingerprint, UBI
sizes). `scripts/lib.sh` loads the one named by `DEVICE`; the values reach the
image as `/etc/nijika_release` (board identity in `01_nijika_sysinfo` and
`board.d`, `fw.sh`, `nijika hw`), the sysupgrade metadata and the device
block of the factory `fwu.sh`. Both installers compare the unit's switch PHY
IDs (`diag rt_port get phy-reg`) with the image's before writing. See
docs/PORTING.md.

## Boot sequence

1. U-Boot loads `ubi_k<n>` (stock FIT kernel) with `root=31:8|11`.
2. The kernel mounts the squashfs and runs `/sbin/init` (procd).
3. **Preinit**
   * `01_nijika_sysinfo`: board name and model from the device profile
     (`/etc/nijika_release`), e.g. `dlink,dpn-fx3060v-a1`,
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
   * **`S11rtk-vendor`**: mounts proc/sys/dev/var/run inside `/rtk` and points
     `/proc/sys/kernel/modprobe` at the stock modprobe. It then runs the patched
     stock rc chain (`/rtk/etc/nijika/rcS`) in the chroot in two phases:
     * **early, synchronous** (`vendor-boot early`, rc0..rc9: stock rc2/rc3):
       mounts `ubi_Config`, `configd`, DSP, all Realtek kernel drivers, OMCI.
       procd does not start the next init script (netifd, rpcd, dropbear, …)
       until this returns (150 s guard), so nothing touches the network devices
       while `ca_ne` is still probing. Before it,
       `net.ipv6.conf.default.disable_ipv6=1` (stock rc14's value) keeps new
       interfaces from sending IPv6/MLD early. Boot 1 crashed without this: an
       interface came up mid-probe and `ca_ni_start_xmit_check` jumped through
       the not-yet-registered TX hook.
     * **late, background** (`vendor-boot late`, rc10..rc63: sysctl, systemd,
       `startup`, VoIP). Before it, `spi-firewall boot` pins the stock SPI
       firewall switches (see *Stock SPI firewall*). It waits for the stock
       "system up" marker, then runs the `post-boot.d` hooks (resolv.conf,
       LAN management rules).
   * `S19dropbear`, `S50uhttpd`, `S12rpcd`: OpenWrt management.
   * **`S95nijika-housekeep`**: re-applies the LAN management rules and the
     `/var` mirror every 60 s. PON/ONT status is **not** polled: LuCI,
     `nijika info` and the login banner read it on demand through
     `pon_cached_env` (`/usr/lib/nijika/pon.sh`), which reuses
     `/tmp/nijika/pon.{env,json}` for `nijika.pon.cache_ttl` seconds (5) and
     serialises refreshes with `flock`, so simultaneous callers run `diag` once.

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

* `home/httpd/boa.conf`: `Port 80` → `Port 8080` (uhttpd/LuCI owns port 80)
* `etc/inetd.conf`: `ssh` line commented (OpenWrt dropbear owns port 22)
* `etc/miniupnpd.conf` **added**: the stock `upnpctrl up` starts miniupnpd
  1.3 as `-i <wan> -a <lan ip> -p 52869` (no `-f`, no `-S`), so it reads
  this default file, which stock does not have: without it any LAN host can
  map any port (22, 80, 443 ...), also to another host's address. Now
  `secure_mode=yes` (mappings only to the requesting host) and only ports
  1024-65535, external and internal (`allow`/`deny` rules; NAT-PMP, which
  stock does not enable, would check them too). Upstream OpenWrt's
  miniupnpd has the same defaults. Services > UPnP turns it on and off.
* `bin/upnpctrl` becomes a wrapper (the real one is `lib/nijika/upnpctrl`):
  the stock one adds the LAN rule for the IGD port (`-I INPUT 1 -i br0 -p
  TCP --dport 52869 -j ACCEPT`) on every start but deletes it without
  `-i br0`, so the copies piled up and the port stayed open after "down".
  The wrapper deletes every copy before `up` and `down`.
* `bin/ccom_linkkit` **removed**: D-Link's Alibaba Cloud Link Kit agent
  (MQTT to `iot-*.aliyuncs.com`, cloud firmware/config push, remote
  property/service calls, AWSS WiFi provisioning, ALCS LAN control). An inert
  placeholder of the same name is there for `startup`/`libmib`. TR-369
  (`obuspa`) and speedtest are kept: they only talk to endpoints
  configured in the MIB (ISP controller) or when used.
* `bin/updatedd` (stock DDNS client) moved to `lib/nijika/updatedd`; the
  wrapper in its place exits: OpenWrt does dynamic DNS (see below).
* `bin/cwmpClient` (TR-069 client) and `bin/snmpd` become wrappers that run
  the real binaries (moved to `lib/nijika/`) only when
  `nijika.vendor.tr069` / `nijika.vendor.snmp` are on, through switch files
  in `/var/nijika` (`/usr/libexec/rtk/stock-services`, at boot before the
  late phase and on every nijika reload). Off by default: the ISP's ACS
  could otherwise reconfigure WAN, WiFi or VoIP behind OpenWrt's back. libmib
  starts both once and finds them by pid file only, so an absent agent is
  never restarted; the TR-069 WAN connection comes up either way.
* Syslog. `/rtk/dev` is the system `/dev`, so the stock syslog daemon
  (`slogd`) re-created `/dev/log` once the late phase started it and from
  then on received everything OpenWrt logged (`logger`, rpcd, ...);
  `logread` only showed daemons that had connected before (until r19).
  Logging straight to logd instead (r20) let the stock services' debug
  chatter flood its 128 KiB ring: `VoIP_maserati` logs about a line a
  second at `local1.info` while its VoIP WAN is down. Now:
  * the stock libc's `/dev/log` is patched to `/var/slg` (same length, one
    occurrence), so stock `syslog()` goes to `/rtk/var/slg`;
  * `/usr/libexec/rtk/logrelay` (procd instance of `rtk-vendor`, static
    musl, `package/rtk-vendor/src/logrelay.c`) passes messages up to
    `nijika.vendor.stock_log` (default 5 = notice, what `slogd -l 5` kept) on
    to logd's `/dev/log`;
  * `bin/slogd` is an inert placeholder (the real one is
    `lib/nijika/slogd`), so `startup` can still start and kill it by name.

  `logread` shows OpenWrt and the stock services' notices, warnings and
  errors; the stock GUI's System Log page stays empty. The stock `dnsmasq`
  has its own `/dev/log` and logs to logd directly (DHCP leases). Messages
  of the early vendor phase, before procd starts the relay, are lost.
* `bin/dnsmasq` moved to `lib/nijika/dnsmasq` behind the DNS over HTTPS
  wrapper (see below).

Every command enters the chroot through `/usr/libexec/rtk/run`, which closes
fd 1000 first: `rc.common` holds its `procd_lock` flock on that fd during
`start`/`reload`, and a stock daemon started from an init script (the
vendor boot itself, `rtk-apply` restarting pppd from a reload) inherited it
and kept the lock for ever. Until r20 every `reload` of `rtk-vendor`
(`nijika.vendor.*`, `nijika.firewall.*` from LuCI) hung in `flock`: the
stock `omci_app` and `pondetect` held the lock taken at boot.

## boa (stock web server)

The stock `boa` is not only the D-Link GUI. At startup it also creates the
**VoIP flash server** (`voip_flash_server_start`, SysV shared memory) that
`VoIP_maserati` waits for. `startup`, `libmib`, `cwmpClient` and the Realtek
`systemd` daemon also track it through `/var/run/boa.pid`. Boot 2 (r5/r6) ran a
pid-only shim instead: `VoIP_maserati` waited forever (`waiting voip flash
server init...`), GWDT killed and relaunched it every 30 s, and the phone ports
never worked.

So the **real boa always runs**, moved to port 8080 (`boa.conf`) because
uhttpd/LuCI owns port 80. This boa build has no `Listen` directive and binds all
addresses, so access is a firewall rule, kept by `lan-mgmt` for IPv4 and IPv6:

boa also opens a built-in HTTPS listener on 443 (`bind_web_socket` in the boot
log; not set in `boa.conf`), so both ports get the same rule:

* `nijika.vendor.boa=hidden` (default): 8080 and 443 are dropped except on
  `lo`. Reach the GUI with `ssh -L 8080:127.0.0.1:8080 root@<router>`.
* `nijika.vendor.boa=lan`: 8080 and 443 are accepted from the LAN bridge.

During boot the stock firewall is rebuilt, and the GUI can be briefly reachable
until the post-boot hook runs; it still requires the stock login.

## Configuration bridge

LuCI never edits stock files directly. The rpcd plugin
`/usr/libexec/rpcd/nijika` calls the same helpers as the `nijika` CLI
(`/usr/lib/nijika/*.sh`), and these run the stock tools in the chroot:

| data | tool | parser |
|---|---|---|
| scalars | `flash get/set KEY` | `kv.awk` |
| chain tables | `flash get TBL`, `flash set TBL.i.field` | `chain.awk` |
| OMCI MEs | `omcicli mib get <class>` | `me.awk` (ordered `[key,value]` pairs + raw) |
| OMCI queue map | `omcicli dump qmap` | `qmap.awk` |
| PON/optics | `diag rt_gpon get onu-state`, `diag pon get transceiver …` | `pon.sh` |
| VoIP | `voipflashcmd get/set NAME [VALUE] CHID PROXY` | |
| U-Boot env | `nv getenv/setenv` | |

`omcicli` hands each request to `omci_app` and reads the answer from a temp
file, but only waits a short while. A big answer (`mib get all`, 200+
priority queues of ME 277) comes back cut off and the rest spills into the
next `omcicli` call. `omci.sh` therefore asks for one class at a time under a
lock, checks that each answer starts with the table name of that class
(`omcicli get tables`), and waits for `omci_app` after a cut-off answer.
`me.awk` marks such answers `"truncated": true`. The OLT Provision page reads
15 classes plus the queue map (about 5 s) and caches it for 30 s.

The awk parsers escape JSON with a character loop: busybox 1.37 awk (OpenWrt)
drops the backslash from `gsub()` replacements, so `"\\\""` would come out as
a bare quote.

Quick Setup writes:

| field | MIB |
|---|---|
| serial | `GPON_SN` |
| PLOAM | `GPON_PLOAM_PASSWD` |
| LOID | `LOID`, `LOID_PASSWD` |
| PPPoE | `ATM_VC_TBL.<i>.{pppUser,pppPasswd,vlan,vid,vprio,MTU}` (first `ChannelMode=2` record by default) |
| WiFi | `WLAN_MBSSIB_TBL.0.{ssid,wpaPSK}` + `SSID`/`WLAN_WPA_PSK` (wlan0), `WLAN1_MBSSIB_TBL.0.*` + `WLAN1_SSID`/`WLAN1_WPA_PSK` (wlan1); band from `WLAN*_PHY_BAND_SELECT` |
| VoIP | `voipflashcmd set … <line> 0` |

Only values that differ are written, and each area is applied the way the
stock GUI applies it ([BOA.md](BOA.md)); the reply lists the applied areas
and sets `reboot_required` only for keys without a live path (`GPON_SN`).

### /etc/config/rtk

`/usr/libexec/rtk/uci-mirror` keeps `/etc/config/rtk` as a UCI view of the
flash MIB: `rtk.mib.<KEY>` for every scalar of `flash all`, and
`rtk.<TABLE>_<n>.<field>` for the records of the tables in `nijika.uci.tables`.
A sync first writes the options that changed in UCI since the previous sync
(compared against a snapshot in `/tmp/nijika`) with `flash set`, then rebuilds
the file from flash; the file is only rewritten when its content changed.
Without a snapshot (first sync after boot) flash wins. Written options are
applied to the running stack through `/usr/lib/nijika/apply.sh` and
`/rtk/bin/rtk-apply`, the libmib calls of the stock web forms
([BOA.md](BOA.md)). Syncs run from the
`40-uci-mirror` post-boot hook, every 10 minutes from `nijika-housekeep`, and
on a `rtk` config change through the reload trigger of `nijika-housekeep`
(`reload_config`, LuCI apply).

## DNS over HTTPS

The LAN keeps using the stock dnsmasq (2.45, started by the stock stack with
`-C /var/dnsmasq.conf`, rewritten on every WAN change). `patch-vendor.sh` moves
the real binary to `/rtk/lib/nijika/dnsmasq` (same name, so `pidof`/`killall`
still find it) and `/rtk/bin/dnsmasq` becomes a wrapper: when
`/rtk/var/nijika/doh` holds the proxy address, it drops the generic
`server=<isp-dns>@<wan-ip>` lines, adds `no-resolv` and
`server=127.0.0.1#5053`, and keeps the ISP's split DNS
(`server=/ims.tm.com.my/...` for voice, `server=/acs.tm.com.my/...` for
TR-069). The stock version of the file is kept as `dnsmasq.conf.stock`, so DoH
can be switched off again without a WAN restart.

`nijika-doh` (START=60) runs `/usr/sbin/https-dns-proxy -a 127.0.0.1 -p 5053
-b <bootstrap> -r <resolver>` under procd and calls `doh-apply`, which writes
or removes the switch file and restarts a running stock dnsmasq when it
changed. `vendor-boot early` writes the switch before the stock stack first
starts dnsmasq. The package's own init script (built around OpenWrt's dnsmasq
and nftables) is removed at assembly. The router's own lookups already go to
the stock dnsmasq (`nameserver 127.0.0.1` in the stock resolv.conf), so they
use DoH too.

## Dynamic DNS

The stock client (`updatedd`, started per `MIB_DDNS_TBL` entry by `systemd`'s
`do_ddns_ctrl` on WAN events) sends the WAN interface's own address over
plain HTTP; behind carrier-grade NAT that is a 100.64.x.x address nobody
can reach. Under NijikaWrt it does not run (wrapper, see above) and
`/usr/libexec/nijika/ddns` does the job, configured in `nijika.ddns` and
`ddns_host` sections (LuCI: Services > DDNS):

* `nijika-ddns` (START=96, procd) runs `ddns run` when DDNS is on and an
  entry is enabled; a nijika change restarts it (`procd_set_param file`).
  Every minute it reads the IPv4 address of the default route's interface
  (`ddns.interface auto`, `ppp0` with PPPoE). A public address is published
  as is; for 100.64.0.0/10 (CGNAT), RFC 1918 or another IANA special-purpose
  range (DS-Lite's 192.0.0.2, TEST-NETs, ...) the public address comes from
  the first `ddns.ip_url` that answers with one, again after
  `check_interval` or when the WAN address changes, and the log and the
  page warn (shared address, use IPv6).
* An entry is sent when the address changed, after `force_interval`
  (default a day, as the stock `DDNS_SYNC_INTERVAL`), or on *Update now*
  (`ddns update -f`, SIGUSR1 to the service). Its state lives in
  `/var/run/nijika-ddns/h.<id>`, `<id>` from its settings, so a changed entry
  is sent again at once. Temporary errors (no connection, HTTP 5xx, `911`)
  retry after 5 to 30 minutes; permanent ones (`badauth`, `nohost`,
  Cloudflare authentication) wait for a settings change or *Update now*, as
  the DynDNS protocol asks.
* Providers: DynDNS v2 (`/nic/update`) for DynDNS, No-IP, Dynu, ChangeIP
  and FreeDNS (afraid.org user name and password); GnuDIP (challenge, salted
  MD5); freedns.afraid.org update URL or token (`update.php?<token>`,
  `sync.afraid.org/u/<token>/`); Cloudflare API v4 (zone id cached, existing
  A records only, PATCH of the content so proxy and TTL stay; e-mail + global
  key as `X-Auth-Email`/`X-Auth-Key`, or a token as `Authorization: Bearer`).
* curl (OpenWrt package, CA bundle from `ca-bundle`) gets URLs and
  credentials as a config on stdin (`-K -`), so they never show in `ps`.
* rpcd: `ddns_status` (`ddns status`: the address check, each entry's last
  result, the stock entries for a hint on the page), `ddns_update`.

## WireGuard

The stock kernel has no WireGuard; `scripts/build-kmod.sh` builds it for
the stock kernel (README: *Kernel modules for the stock kernel*) into
`/usr/lib/nijika/kmod/5.10.70/` with `wireguard.load` (dependencies first:
libchacha, chacha-neon, poly1305-neon, libchacha20poly1305,
libcurve25519(-generic), libblake2s(-generic), wireguard). `wg` comes from
OpenWrt's `wireguard-tools` (its 6.12 `kmod-wireguard` dependency is
dropped at assembly with the other kmods), QR codes from `qrencode`.

`/usr/libexec/nijika/wireguard` (`nijika-wireguard`, START=97, procd
reload trigger on `nijika`):

* `up`: `insmod` the modules not loaded yet, `ip link add wg0 type
  wireguard`, `wg syncconf` from a generated `[Interface]`/`[Peer]` file
  (running sessions survive a settings change), MTU (WAN MTU - 80),
  addresses, routes. Allowed IPs outside wg0's subnets (a site's LAN) are
  routed to wg0, never `0.0.0.0/0`/`::/0`: the stock stack owns the default
  route. `ip rule ... to <net> lookup main pref 900` keeps those
  destinations out of the stock policy routing tables.
* Crash guard: `/etc/nijika/wireguard.loading` is written and synced before
  the modules are loaded and removed after. If loading ever took the kernel
  down, the next start finds it and refuses to load them again (the page
  shows why) until `/usr/libexec/nijika/wireguard retry`: no crash at every
  boot.
* Firewall, in the stock iptables (chroot): `INPUT` accepts the UDP port
  and everything from wg0, `FORWARD` accepts wg0 both ways (IPv4 and
  IPv6), `nat POSTROUTING` masquerades the tunnel's IPv4 subnet out of the
  WAN. The stock `startup` rebuilds its ruleset on WAN changes, so
  `nijika-housekeep` runs `wireguard firewall` every minute (like
  `lan-mgmt`). The rules applied are kept in `/var/run/nijika-wg/fw`, so
  a changed port or subnet replaces the old rules.
* `client <peer>`: the peer's configuration when its private key stays on
  the router (keys made by the page): its single-address allowed IPs as
  `Address`, the router's LAN address as DNS, `client_allowed_ips`
  (default `0.0.0.0/0`), keepalive 25, and the endpoint: `wireguard.endpoint`,
  else the first DDNS host name, else the WAN's public IPv4 (`ddns wan`, no
  lookup), else a global IPv6 address of the router (behind CGNAT nothing
  reaches the router over IPv4).
* `wireguard debug on|off`: WireGuard's own kernel log through dynamic
  debug (`dmesg | grep wireguard`): handshakes sent, received and
  rejected, packets from addresses outside a peer's allowed IPs. The
  quickest way to tell "nothing arrives" (ISP, path) from "arrives but is
  refused" (keys, preshared key, allowed IPs).
* rpcd: `wg_status` (`wg show wg0 dump` per peer: handshake, transfer,
  endpoint), `wg_keys` (key pair + preshared key, or the public key of a
  private key), `wg_client` (configuration and its QR code as SVG; write
  ACL, it holds a private key).

## Traffic control (QoS)

Two ways to do QoS on this unit. LuCI Network > QoS is the hardware one;
the software one is groundwork (modules and `tc`, no page).

* **Hardware (the stock QoS)**: the stock pages (Advance > Upstream /
  Downstream QoS Policy, QoS Classification, Traffic Shaping), in LuCI as
  Network > QoS (`nijika/qos`, rpcd `qos_get` / `qos_set`,
  `/usr/lib/nijika/qos.sh`; records and encodings: [BOA.md](BOA.md#ip-qos-advance--qos-pages-ip_qos_-tables)).
  They are `libmib`'s IP QoS. iptables/ebtables chains (`QOS_IP_US_CHAIN`,
  `QOS_EB_DS_CHAIN`, ...) put a queue and a meter id into the skb mark; the
  FC hardware NAT (`fc_8277c.ko`, `/proc/fc/ctrl/skbmark_qid`,
  `skbmark_meterId`) offloads the flow with them, and the CA8277 network
  engine schedules 8 queues (strict priority, WRR, CAR:
  `rt_qos_schedulingQueue_set`, `rtk_ponmac_*`) and polices rates with
  hardware meters (`rtk_qos_share_meter_set`). Almost no CPU, but only
  priorities and hard caps: no AQM, no per-flow fairness. Linux `tc`
  (`prio bands 8`, HTB) only covers what stays on the CPU.
* **Software (Linux qdiscs)**: the stock kernel has fq_codel, HTB, TBF and
  PRIO built in, the `u32` and `fw` classifiers, iptables `CLASSIFY`/`DSCP`/
  `MARK` and ipset; CAKE is built for it (`sch_cake.ko`, `sch_cake.load`,
  README: *Kernel modules for the stock kernel*). `tc` is OpenWrt's
  `tc-tiny` (the stock `/rtk/bin/tc` has no CAKE). Two limits:
  * Flows offloaded by the FC hardware NAT never reach a qdisc: software
    QoS needs `hwnat` off (`/proc/fc/ctrl/hwnat`) or the flows it shapes
    kept on the CPU (`skbmark_fwdByPs`, `skbmark_skipFcFunc`).
  * No ingress shaping: `NET_CLS_ACT` (and with it `sch_ingress`, IFB and
    tc actions such as `mirred`/`police`) is off and is not a module, it
    changes `struct sk_buff`. Downloads are shaped on the LAN egress
    (`br0`) instead.
  * Measured on an A1 (`hwnat` 0, CAKE on `ppp0` and `br0`): the CPU
    forwards 160-215 Mbit/s downstream (two cores at 100 % softirq; CPU2
    is not in the vendor's RPS mask `b`), so a 385 Mbit/s line loses half
    its download; upstream latency under load improved (12 ms instead of
    up to 260 ms).
* **Not usable as-is**: the FC driver's own AQM (`diag rt_qos ... aqm`: a
  flow table that sorts flows into small / middle / big, then "Modify
  COS" or hardware PIE). With the one PON queue the OLT provisions
  (`diag rt_gpon show tcont-queue`), Modify COS sends flows to a T-CONT
  queue that does not exist; hardware PIE acts on the path to the LAN
  only.

## Firewall and services

The stock `startup` builds the iptables/ebtables ruleset, NAT, PPPoE
(`spppd`), DHCP/DNS (`dnsmasq`), UPnP, IGMP proxy and TR-069, all from the
MIB. OpenWrt's `firewall4`, `dnsmasq`, `odhcpd` and `ppp` are not installed
(the stock kernel has no nftables anyway). `lan-mgmt` inserts accept rules for
TCP 22/80 on `br0` into the stock INPUT chain and re-checks them every minute.
It also accepts ping (ICMP/ICMPv6 echo request, max 10/s) from anywhere but
the LAN when `nijika.firewall.wan_ping` is on (default): the stock remote
access table (`ACC_TBL`, `icmp` without the WAN bit) puts
`-A inacc ! -i br0 -p icmp --icmp-type 8 -j DROP` in the stock chain.

### Stock SPI firewall

The *SPI Firewall* switches of the stock GUI (Firewall > IPv4/IPv6 Port
Filtering) are the default actions of the stock forwarding filter, the chains
`ipfilter` and `ipv6filter` hooked into FORWARD only. The router's own services
are guarded by the INPUT rules (`inacc`, Remote Access, `lan-mgmt`) whatever
they say.

| MIB | GUI | factory |
|---|---|---|
| `IPF_IN_ACTION`, `V6_IPF_IN_ACTION` | Incoming | `0` (ON: new connections from the WAN dropped) |
| `IPF_OUT_ACTION`, `V6_IPF_OUT_ACTION` | Outgoing | `1` (OFF; ON drops every new LAN connection) |

`0` is the GUI's ON (drop), `1` its OFF (allow). `spi-firewall boot` pins them
from `nijika.firewall.spi_ipv4` / `spi_ipv6` between the early phase (configd
is up) and the late one (`startup` builds the chains), writing only values
that differ. `off` (default) sets both directions to `1`, `on` restores the
factory pair, `keep` leaves them alone; outgoing ON is never written. A uci
reload of `nijika` writes them too and rebuilds the running stock firewall
(`rtk-apply firewall`, see [BOA.md](BOA.md)). The MIB is
shared with the stock bank, which therefore boots with the same switches.

## A/B upgrades

Two images come out of one build (see [FLASH_LAYOUT.md](FLASH_LAYOUT.md)):
`-factory.bin` (stock tar with `fwu.sh`, for the D-Link web GUI) and
`-sysupgrade.bin` (OpenWrt NAND sysupgrade tar + fwtool metadata).
`/usr/lib/nijika/fw.sh` detects the format, and `/lib/upgrade/platform.sh`
replaces the armsr disk logic:

* Stock protection: `fw_check_target` refuses when the other bank's
  `sw_version` is not `NijikaWrt*` (the stock D-Link fallback). Overrides:
  `sysupgrade -F` (a failed `platform_check_image` stays forceable),
  `nijika upgrade --replace-stock`, and the LuCI confirmation (`replace_stock`).
* `REQUIRE_IMAGE_METADATA=1`: sysupgrade checks `supported_devices` against
  `dlink,dpn-fx3060v-a1`. Factory/stock tars have no metadata and need
  `-F`.
* `platform_check_image`: format detection, then md5 (factory) or fwtool CRC
  plus board (sysupgrade), squashfs magic, and size against the UBI volume.
* `platform_pre_upgrade`: runs in stage2 while the root is still mounted.
  Writes the other bank with `ubiupdatevol`, sets `sw_tryactive`, marks the
  overlay for a wipe and stores the kept config on it.
* `platform_do_upgrade` / `platform_copy_config`: nothing left to do.

Stock D-Link images use the factory format, so a forced sysupgrade, *Nijika →
Firmware Banks* or `nijika upgrade` also flashes back to stock.
