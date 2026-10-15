# Live apply: what the stock boa does after "Apply"

The stock web server (boa) changes the running stack without a reboot. Every
`/boaform/<form>` handler does the same three things: parse the POST, write
the configuration (`mib_set`, `mib_chain_update`), then call a libmib
function that makes the running services follow it (and `Commit()`).
NijikaWrt writes with the stock `flash set`, which commits the same way, and
then makes the same libmib calls through `/rtk/bin/rtk-apply`.

Committing hands the change to `configd`, which keeps it in RAM and writes
flash later ("delay mib commit" on the console) or when the stock reboot
runs `mib commit cs now`. NijikaWrt's reboot does that too
(`/usr/libexec/rtk/vendor-shutdown`, see [Reboot](#reboot)).

Sources: the stock V1.1.2 `boa` (Ghidra, sha256 `f46f8845…dbb1`) and the
Realtek Luna SDK userland of the same generation (`user/boa/src/LINUX`:
`utility.h`, `subr_net.c`, `subr_fw.c`, `form_src_generic/*`). Every
constant and prototype below was checked against the stock binary.

## The form handlers

boa registers its forms in one table (`boaFormDefine` in the SDK's
`boamain.c`; `FUN_0041f870(name, fn)` from `FUN_00422f48` in the stock
binary). The apply part of the handlers behind the pages NijikaWrt cares
about:

| Stock page | Form (boa address) | Apply calls, in order |
|---|---|---|
| Firewall > IPv4/IPv6 Port Filtering (SPI switches, rules), DMZ | `formFilter` (0x45ea34), `formFilterV6` (0x43d694), `formDMZ` | `restart_IPFilter_DMZ_MACFilter()`: rebuilds `ipfilter`, `dmz`, the MAC filter, calls `restart_IPV6Filter()`, flushes the hardware flow cache |
| LAN Interface Settings | `formTcpipLanSetup` (0x45b004) | `restart_lanip()` (after the reply, from boa's main loop), plus per field `restart_ethernet(port)`, `setup_wlan_block()`, `rtk_multicast_snooping()`, `restart_upnp()`, `restartLanV6Server()` |
| DHCP server | `formDhcpServer` -> `formDhcpd` | `restart_lanip()` when the address changed, `restart_dhcp()` |
| PON WAN, edit | `formWanEth` -> `formEth` (0x46e3f8) | `deleteConnection(CONFIGONE, &old)`, `mib_chain_update`, `restartWAN(CONFIGONE, &new)`, `reSync_reStartVoIP()` |
| PON WAN, delete | `formEth`, `formStatus` | `deleteConnection(CONFIGONE, &e)`, `mib_chain_delete`, `restartWAN(CONFIGONE, NULL)` |
| IPv6 on/off | `formIPv6EnableDisable` (0x43a840) | `deleteConnection(CONFIGALL, NULL)`, `restartWAN(CONFIGALL, NULL)` |
| WLAN Basic, Security | `formWlanSetup` (0x43153c), `formWlEncrypt` (0x4322d8) | `config_WLAN(ACT_RESTART, CONFIG_SSID_ALL)`, the same call as the stock `wlan_apply restart` |
| GPON Settings | `formgponConf` (0x42ad0c) | LOID: `omcicli set loid <loid> [<password>]`; PLOAM: `rt_gpon_deactivate()`, `diag rt_gpon set registrationId-hex <hex>`, `rt_gpon_activate(0)`; LOID, Device Type or OLT mode changed: `restartOMCIsettings` (`rt_gpon_deactivate()`, `omcicli mib reset`, `rt_gpon_activate(0)`) |
| VoIP | `web_restart_solar` (0x481018) | `voip_flash_server_update()`, `echo x > /var/run/solar_control.fifo`, the same as `reSync_reStartVoIP()` |

Constants: `CONFIGONE 0`, `CONFIGALL 1` (utility.h), `ACT_RESTART 3`
(mib.h), `CONFIG_SSID_ALL 8` (subr_wlan.h). PLOAM hex: each password byte
as two hex digits, `00`-padded to 10 bytes (GPON) or 36 (XG-PON).

A WAN edit tears the connection down with its **old** settings before the
record changes: the interface, pppd and routes are named after the old
record.

## rtk-apply

`package/rtk-vendor/src/rtk-apply.c`, built by `scripts/build-helpers.sh`
during `assemble` and installed as `/rtk/bin/rtk-apply`. It runs in the
chroot (`rtk /bin/rtk-apply <cmd>`) and links against the stock libraries
like the stock `wlan_apply`; libmib reaches `configd` through its message
queue, no initialisation needed.

| Command | Calls |
|---|---|
| `firewall` | `restart_IPFilter_DMZ_MACFilter()` |
| `lan` | `restart_lanip()`, `restart_dhcp()` |
| `wan-down <n>` | `deleteConnection(CONFIGONE, &ATM_VC_TBL[n])` |
| `wan-up <n>` | `restartWAN(CONFIGONE, &ATM_VC_TBL[n])`, `reSync_reStartVoIP()` |
| `wan` | `deleteConnection(CONFIGALL, NULL)`, `restartWAN(CONFIGALL, NULL)`, `reSync_reStartVoIP()` |
| `wan-delete <n> [dhcpc]` | the stock delete: `rtk_layer2bridging_update_wan_interface_mib_table(0, ifIndex, 0)`, [`delDhcpcOption(ifIndex)`], `rtk_tr181_update_wan_interface_entry_list(0, &e, NULL)`, `clear_delegated_default_wanconn(&e)`, `deleteConnection(CONFIGONE, &e)`, `resolveServiceDependency(n)`, `mib_chain_delete`, `restartWAN(CONFIGONE, NULL)`, `reSync_reStartVoIP()`, `Commit()` |
| `wlan` | `config_WLAN(ACT_RESTART, CONFIG_SSID_ALL)` |
| `wlan-block` | `setup_wlan_block()` |
| `snooping` | `rtk_multicast_snooping()` |
| `lan-port <n>` | `restart_ethernet(n + 1)` |
| `voip` | `reSync_reStartVoIP()` |
| `gpon-omci` | `rt_gpon_deactivate()`, `omcicli mib reset`, `rt_gpon_activate(0)` |
| `gpon-ploam <pw>` | `rt_gpon_deactivate()`, `diag rt_gpon set registrationId-hex`, `rt_gpon_activate(0)` |

MIB ids are enum positions that differ between builds, so the helper never
hardcodes them: `mib_chain_info_name("ATM_VC_TBL")` gives the id (offset 0)
and the record size (offset 40) at run time; WAN records are passed through
as opaque buffers.

Build notes: the stock userland is aarch64 glibc 2.30. A distribution
aarch64 gcc links against its own newer glibc (a 2.34+ `__libc_start_main`
the stock loader does not have), so the helper is built with `zig cc
-target aarch64-linux-gnu.2.30` (`ZIG` in `build.conf`). `librtk.so` has no
SONAME: linked by path, the build host's path would land in `DT_NEEDED`, so
the build links against a stub that carries `SONAME librtk.so` (and the two
`rt_gpon_*` symbols the helper calls); the stock library is loaded at run
time. `tests/run.sh helpers` checks the result under qemu with
`LD_BIND_NOW=1`.

## Who applies what

`/usr/lib/nijika/apply.sh` maps each written flash key to an area and runs
the matching commands. The UCI mirror (`/etc/config/rtk`), the LuCI MIB
editor, Quick Setup, the SPI firewall setting and the `nijika` CLI (`mib
set`, `isp`, `ploam`, `loid`) use it.

| Keys | Area | Before writing | After writing |
|---|---|---|---|
| `ATM_VC_TBL.<n>.*` | `wan:<n>` | `wan-down <n>` | `wan-up <n>` |
| `SW_PORT_TBL.<n>.Enable` | `port:<n>` | | `lan-port <n>` |
| `MP_MODE` (IGMP snooping, bit 2) | `snooping` | | `snooping` |
| `WLAN_BLOCK_ETH2WIR` | `wlanblock` | | `wlan-block` |
| `IPF_*`, `V6_IPF_*`, `MACF_*`, `DMZ_*`, `IPFILTER_SPI_ENABLE`, `V6_SESSION_FW_ENABLE`, filter tables | `firewall` | | `firewall` |
| `LAN_IP_ADDR`, `LAN_SUBNET`, `LAN_*2`, `LAN_DHCP*`, `DHCP_MODE`, `DHCPS_*` | `lan` | | `lan` |
| `WLAN_*`, `WLAN1_*`, `WSC_*`, `SSID` | `wlan` | | `wlan` |
| `LOID`, `LOID_PASSWD` | `loid` | | `omcicli set loid`, then `gpon-omci` last |
| `GPON_PLOAM_PASSWD` | `ploam` | | `gpon-ploam` |
| `DEVICE_TYPE`, `OMCI_OLT_MODE` | `omci` | | `gpon-omci` (once, last) |
| VoIP (`voipflashcmd set`, Quick Setup) | `voip` | | `voip` |
| anything else (`GPON_SN`, OMCI identity, ...) | `reboot` | | read when the stock services start |

Order after writing: WAN records, firewall, LAN, WiFi, LOID, PLOAM, OMCI restart, VoIP.
LuCI replies first and applies a second later, so a WiFi or WAN restart can
not outlast the call. `nijika.vendor.live_apply=0` turns all of it off.

Changing PON or WAN settings drops the Internet connection for a moment,
changing the LAN address drops the browser's connection: the same as with
the stock GUI.

`nijika apply wan [n]|firewall|lan|wlan|voip|gpon` runs a step by hand.

## Reboot

The stock reboot (`cmd_reboot` -> configd `sysReboot`) first releases the
WAN connections (`doReleaseWanConneciton`: `spppctl force_down <unit>` for
each PPPoE session, i.e. LCP Terminate-Request and PADT; `SIGUSR2` to each
DHCP client), sleeps a second, runs `mib commit cs now`, syncs and reboots.
Without the release the ISP's BRAS keeps the old PPPoE session until its
keepalive times out, which can delay the next login.

NijikaWrt reboots through procd, so `/etc/init.d/rtk-vendor` has a
`shutdown()` (`K10rtk-vendor`) that runs `/usr/libexec/rtk/vendor-shutdown`:
the same release and commit, without the final `reboot()`. sysupgrade skips
the K scripts, so `platform_pre_upgrade` calls it after writing the image.

## Deleting a WAN connection

The stock PON WAN page deletes a connection with the sequence of
`rtk-apply wan-delete` (`dhcpc` when the record is an IPoE DHCP client:
`ChannelMode` 1, `ChannelAddrType` 1). `wan_delete` in
`/usr/lib/nijika/apply.sh` (LuCI Network > PON WAN, `nijika wan delete`)
adds one thing the stock page does not: the deleted connection's LAN ports
and SSIDs (`itfGroup`) go to the connection with the default route when that
one binds its ports explicitly, so no port is left without a connection.
The records after it move down by one; `/etc/config/rtk` is rebuilt. The
LuCI pages name connections `PON_<ifIndex & 0xff>` (stock:
`Connection_<n>`), which does not change when another record goes.

Port mapping (`itfGroup`) bits on the A1 (stock `virt2user` = 1..7,
4 SSIDs per radio, 14 checkboxes on the stock page): 0-3 LAN1-4, 4 wlan0
(5 GHz), 5-8 its guest SSIDs, 9 wlan1 (2.4 GHz), 10-13 its guest SSIDs. A
port belongs to one connection (stock `check_itfGroup`).

