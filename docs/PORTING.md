# Porting NijikaWrt to another hardware revision

NijikaWrt was brought up on the DPN-FX3060V **A1**. The next candidate is the
**B1**, which adds a 2.5GbE port through a Realtek RTL8221B PHY and ships with
stock firmware V2.x. This page is the checklist for that kind of port, and the
list of everything A1 taught us.

## What is device-specific

Everything that differs between revisions lives in one place:

| | |
|---|---|
| `devices/<id>/device.conf` | board name, model, stock firmware pattern, hardware fingerprint (switch PHY IDs), UBI volume sizes |
| `devices/<id>/NOTES.md` | the measured facts behind those values (ports, PHYs, quirks) |
| `stock/` | the stock firmware of that revision: kernel, device tree and the vendor userland come from it |

`DEVICE=<id> ./build.sh` builds for it (default: `dpn-fx3060v-a1`, set in
`build.conf`). The profile ends up in the image as `/etc/nijika_release`
(`NIJIKA_DEVICE`, `NIJIKA_BOARD`, `NIJIKA_MODEL`, `NIJIKA_PHY_IDS`, ...), the
sysupgrade metadata (`supported_devices`, `nijika.phy_ids`) and the device
block of the factory `fwu.sh`.

If a new revision needs anything else to change, add a variable to
`device.conf` rather than an `if` on the device name. `tests/run.sh lint`
flags device ids hardcoded outside `devices/`.

### The hardware guard

Every image carries the stock kernel and device tree of ONE revision, so
installing it on another one can leave the unit without Ethernet or without
boot. The installers check before writing anything:

* factory image on the stock firmware (`fwu.sh`): stock `/etc/version` must
  match `DEVICE_STOCK_MATCH`, and the switch PHY IDs must equal
  `DEVICE_PHY_IDS`;
* sysupgrade / `nijika upgrade` / LuCI on NijikaWrt (`fw.sh`): board
  (`supported_devices`) and the image's PHY IDs against this unit; a stock
  D-Link image against this revision's `NIJIKA_STOCK_MATCH`.

Unreadable PHY IDs only warn. `touch /tmp/nijika_force` (or `sysupgrade -F`)
overrides. `nijika hw` shows the expected and the live fingerprint.

## Bring-up checklist (B1)

1. **Collect the facts on the stock firmware.** Copy `tools/probe.sh` to the
   B1 (serial or telnet shell) and run it. Its hardware section prints the
   switch port status, the PHY ID of every switch port, the device tree, the
   relevant kernel options and the PHY boot messages; it also records `/proc/mtd`,
   the UBI volumes and the U-Boot environment.
2. **Get the stock firmware** (`DPN-FX3060V_V2.x_....bin`) into `stock/`.
3. **Compare with A1** (`devices/dpn-fx3060v-a1/NOTES.md`): kernel config
   (2.5G PHY driver, bonding, netfilter), UBI volume sizes (`pfl_*_sz`), MTD
   layout, `/etc/version` format, stock rc scripts (`/etc/init.d/rc*`), the
   stock tools (`diag rt_gpon`, `omcicli`, `flash`, `nv`, `voipflashcmd`), boa,
   FXS count, WiFi.
4. **Create `devices/dpn-fx3060v-b1/`**: copy the A1 profile and set
   `DEVICE_ID`, `DEVICE_BOARD`, `DEVICE_MODEL`, `DEVICE_STOCK_MATCH` (e.g.
   `^DPN-FX3060V_V2\.`), `DEVICE_STOCK_MIN` (B1: `V2.0.7`, AGENTS.md section
   10), `DEVICE_PHY_IDS` (from step 1; the RTL8221B reads `001cc849`) and
   the UBI sizes. Write the facts into `NOTES.md`.
5. **Build and test**: `DEVICE=dpn-fx3060v-b1 ./build.sh` and `tests/run.sh`.
   The `fwu` group runs against the B1 factory image; the dry run takes the
   matching (and a differing) fingerprint and stock version from the image's
   own `fwu.sh`. Add the B1 stock version to its sample list if the pattern
   does not match `V2.0.6`.
6. **First boot over serial**, watching for the A1 pitfalls below: vendor rc
   numbering (`vendor-boot` runs rc0..9 synchronously, then rc10..63), the
   rc lines `patch-vendor.sh` comments out (it matches by content and logs what
   it changed), boa and the VoIP flash server, `fw_loaded.sh`, the U-Boot env
   after a trial boot (`nijika boot`), the LAN port to `eth0.N` mapping and the
   2.5G port's speed.
7. **With fibre**: `tools/omci-capture.sh` for an OMCI baseline; add the parts
   the parsers need to `tests/fixtures/` (with serials and credentials removed),
   and check *PON > OLT Provision*.

## What A1 taught us

| Symptom | Cause | Handled in |
|---|---|---|
| kernel panic in `ca_ne` (`ca_ni_start_xmit_check`) at boot | an interface sent IPv6 MLD while the driver was still probing, with OpenWrt services running in parallel | `vendor-boot early`: rc0..9 synchronous, `disable_ipv6` default before the drivers load |
| `fw_loaded.sh: not found`, WiFi `cmd`/`cmd1` missing | the chroot PATH lacked `/etc/scripts` (stock busybox init sets it) | `usr/libexec/rtk/run`: stock init environment |
| `waiting voip flash server init...` and GWDT restarting `VoIP_maserati` every 30 s | the stock boa starts the VoIP flash server (SysV shm); a shim boa does not | `patch-vendor.sh` (boa on 8080), `lan-mgmt` (firewall 8080 and its built-in 443) |
| trial boot never committed, `sw_active` naming the wrong bank, stock GUI "ubiupdatevol busy" | U-Boot's `saveenv` inside `bootcmd` does not reach the flash | `lib/preinit/03_nijika_bootenv`, `fwu.sh` bank check |
| LuCI pages broken or `\n` shown as `n` | busybox 1.37 awk drops backslashes from `gsub()` replacements (1.36 on the build host does not) | character-loop JSON escaping; `tests/run.sh lint` |
| `omcicli mib get all` cut off, the rest appearing in the next command | omcicli waits only briefly for omci_app | `omci.sh`: one class per request, header check, pause after a cut-off answer |
| OLT Provision page timing out without fibre | empty OMCI tables end with the header, not `=====` | `omci.sh` |
| ONU state "unknown", alarms empty | `diag gpon ...` is the old tree ("driver not found"); this SoC uses `diag rt_gpon`, which has no alarms | `pon.sh` (LOS from RX power) |
| WAN records empty | `flash get <TABLE>` prints `%-18s = %s` (padded), single members `field=value` | `chain.awk`, `mib_get` |
| prompt shows `RTK_GW` | stock `startup` writes MIB `DEVICE_NAME` to the kernel hostname | `usr/libexec/rtk/hostname` (housekeep) |
| DNS changes lost after a WAN event | stock `startup` rewrites `/var/dnsmasq.conf` and restarts its dnsmasq 2.45 | `rtk/bin/dnsmasq` wrapper |
| VoIP or TR-069 broken by a DNS change | the ISP's own domains need the ISP's DNS on their VLAN (`server=/ims.../`, `server=/acs.../`) | the wrapper keeps those lines |
| files missing from git | `.gitignore` had `bin/` (matches every `bin` directory) | anchored to `/bin/` |
| hostname, model, LAN ports | identical device tree string on every Taurus board | the PHY ID fingerprint, not the DT, tells revisions apart |

## Tests

`tests/run.sh` runs offline in about 20 s: shell syntax, JSON, lint rules,
the parsers against real A1 captures, the dnsmasq wrapper, the
`/etc/config/rtk` quoting, the boot-env hook, every factory installer scenario
(including other-revision hardware and stock firmware) and the banner. Run it
before every image; add fixtures when a new revision prints something
differently.
