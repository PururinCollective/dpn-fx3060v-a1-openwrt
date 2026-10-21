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
| Advance > Upstream / Downstream QoS Policy | `formUpstreamQosPolicy` (0x443644), `formDownstreamQosPolicy` (0x443dbc) | `stopIPQ()` before `QOS_POLICY` / `QOS_DOWNSTREAM_POLICY` changes, then `Commit()`, `take_qos_effect()` |
| Advance > QoS Classification | `formQosRuleEdit` (0x440e78, add / edit: `mib_chain_add` / `_update`, `UpdateQoSOrder`), `formQosRule` (0x4426d8, delete, Apply) | `take_qos_effect()`, `Commit()` |
| Advance > Traffic Shaping | `formQosTraffictlEdit` (0x44232c, add), `formQosTraffictl` (0x441a3c: total bandwidth Apply / Clear, delete) | `take_qos_effect()`, `Commit()` |

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
| `wan-mode <n>` | the connection mode of record n changed (stock formEth, edit): `resolveServiceDependency(n)` while the record has its old interface index, a PPP unit for PPPoE (lowest free, the old one if still free) or none (`0xff`), then `rtk_layer2bridging_update_wan_interface_mib_table(2, old, new)`, `updatePortForwarding(old, new)`, `updateRoutingTable(old, new)`, `rtk_tr181_update_wan_interface_entry_list(2, &old, &new)`, `mib_chain_update`, `Commit()`. Unlike the stock form the VC slot (and the name `PON_<n>`, the MAC) stays. Needs the V1.1.2 record layout (0x3c4 bytes, `cmode` at 0x15). |
| `wan` | `deleteConnection(CONFIGALL, NULL)`, `restartWAN(CONFIGALL, NULL)`, `reSync_reStartVoIP()` |
| `wan-delete <n> [dhcpc]` | the stock delete: `rtk_layer2bridging_update_wan_interface_mib_table(0, ifIndex, 0)`, [`delDhcpcOption(ifIndex)`], `rtk_tr181_update_wan_interface_entry_list(0, &e, NULL)`, `clear_delegated_default_wanconn(&e)`, `deleteConnection(CONFIGONE, &e)`, `resolveServiceDependency(n)`, `mib_chain_delete`, `restartWAN(CONFIGONE, NULL)`, `reSync_reStartVoIP()`, `Commit()` |
| `wlan` | `config_WLAN(ACT_RESTART, CONFIG_SSID_ALL)` |
| `wlan-block` | `setup_wlan_block()` |
| `portfw` | formPortFw (0x45d730) after its `Commit()`: `reWriteAllDhcpcScript()`, `setupPortFW()` |
| `qos-stop` | the QoS policy forms before the policy changes: `stopIPQ()` |
| `qos` | the QoS forms after their writes: `take_qos_effect()` (`stopIPQ()`, `setupIPQ()`) |
| `easymesh <role> <prev> <backhaul> [norestart]` | formMultiAP (0x44791c) Apply: `setupMultiAPController(role, prev, backhaul, &dhcp)` / `setupMultiAP_TMAuto()` / `setupMultiAPDisabled()`, `config_WLAN(ACT_RESTART, CONFIG_SSID_ALL)`, `Commit()` |
| `easymesh-pair` | formMultiAP Start PBC (controller): `echo 2 > /tmp/virtual_push_button` |
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
| `ATM_VC_TBL.<n>.ChannelMode` | `wanmode:<n>` (before `wan:<n>`) | | `wan-mode <n>` |
| `ATM_VC_TBL.<n>.*` | `wan:<n>` | `wan-down <n>` | `wan-up <n>` |
| `SW_PORT_TBL.<n>.Enable` | `port:<n>` | | `lan-port <n>` |
| `MP_MODE` (IGMP snooping, bit 2) | `snooping` | | `snooping` |
| `WLAN_BLOCK_ETH2WIR` | `wlanblock` | | `wlan-block` |
| `IPF_*`, `V6_IPF_*`, `MACF_*`, `DMZ_*`, `IPFILTER_SPI_ENABLE`, `V6_SESSION_FW_ENABLE`, filter tables | `firewall` | | `firewall` |
| `PORT_FW_ENABLE`, `PORT_FW_TBL` | `portfw` | | `portfw` |
| `ENABLE_QOS`, `QOS_POLICY`, `TOTAL_BANDWIDTH`, `TOTAL_BANDWIDTH_LIMIT`, `ENABLE_DSCP_MARK`, `ENABLE_1P`, their `DOWNSTREAM` twins, the `IP_QOS_*` tables | `qos` | `qos-stop` | `qos` |
| `LAN_IP_ADDR`, `LAN_SUBNET`, `LAN_*2`, `LAN_DHCP*`, `DHCP_MODE`, `DHCPS_*` | `lan` | | `lan` |
| `WLAN_*`, `WLAN1_*`, `WSC_*`, `SSID` | `wlan` | | `wlan` |
| `LOID`, `LOID_PASSWD` | `loid` | | `omcicli set loid`, then `gpon-omci` last |
| `GPON_PLOAM_PASSWD` | `ploam` | | `gpon-ploam` |
| `DEVICE_TYPE`, `OMCI_OLT_MODE` | `omci` | | `gpon-omci` (once, last) |
| VoIP (`voipflashcmd set`, Quick Setup) | `voip` | | `voip` |
| anything else (`GPON_SN`, OMCI identity, ...) | `reboot` | | read when the stock services start |

Order after writing: WAN records, firewall, port forwarding, QoS, LAN, WiFi, LOID, PLOAM, OMCI restart, VoIP.
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


## WAN channel modes and ports (formWanEth, V1.1.2)

D-Link's `retrieveVcRecord` (0x46b5a8, IPv6 part 0x46aae0, bridge part
0x46b4a4) stores the "Channel Mode" select as:

| Stock GUI | `ChannelMode` | Also |
|---|---|---|
| Bridged | 0 | `BridgeType` 0 Ethernet / 1 PPPoE |
| IPoE | 1 | `ChannelAddrType` 0 (static) |
| DHCP | 1 | `ChannelAddrType` 1 |
| PPPoE | 2 | |
| DS-Lite | 6 | IPv6 only (`IpProtocol` 2); `dslite_enable`, `dslite_aftr_mode` (0 from DHCPv6, 1 manual), `dslite_aftr_hostname` |
| 6rd | 8 | `IpProtocol` 3, `AddrMode` 8, `SixrdMode` (1 auto, 0 manual), `SixrdBRv4IP`, `SixrdIPv4MaskLen`, `SixrdPrefix`, `SixrdPrefixLen` |

Routed modes have `BridgeType` 2 unless "Enable Bridge" (then 0/1, a hybrid
connection). The stock page sets MTU 1492 / MSS 1452 / 1432 for PPPoE and
1500 / 1460 / 1440 otherwise.

Ports: `itfGroup` binds LAN ports (bits 0-3) and SSIDs (4-13) to the
connection. A LAN port also set in `vlanTagGrp` is bound through a
`<port>.<VID>` sub-interface instead of the plain port (libmib
`setup_vlan_tagging_intf`, the port mapping rules in FUN_00203cb0): it
carries the connection's VLAN tagged. A `vlanTagGrp` bit without the
`itfGroup` bit binds nothing (the stock page refuses it); WiFi bits are
ignored. `check_itfGroup` (libmib) takes a port away from another
connection only when one of the two is routed only (`BridgeType` 2). LuCI
shows the two masks as "Port mapping" (untagged) and "VLAN tagging"
(tagged, saved in both masks) and keeps tagged ports out of that check, so
several bridged connections can carry their VLANs tagged on one port next
to one untagged connection.

## WiFi (formWlanSetup, formAdvanceSetup, formWsc)

* Band (`WLAN_BAND`, `WLAN1_BAND`, also every record's `wlanBand`): bits
  1 b, 2 g, 4 a, 8 n, 64 ac, 128 ax. A mode without the older bits makes
  libmib write `/proc/net/rtk_wifi6/<if>/deny_legacy`: 2.4 GHz 138 (g/n/ax)
  refuses 802.11b, 136 (n/ax) also g, 128 everything but 802.11ax; 5 GHz
  200 (n/ac/ax) refuses 802.11a, 192 (ac/ax) also n, 128 everything but
  802.11ax. hostapd keeps HT/VHT on (`ieee80211n`/`ac` follow the ax bit).
* OFDMA: `WLAN_OFDMA_ENABLED` / `WLAN1_OFDMA_ENABLED`, off when the band has
  no 802.11ax.
* 802.11r per SSID: `WLAN_FT_ENABLE`, `WLAN_FT_MDID`, `WLAN_FT_OVER_DS` (the
  stock Advanced page sets it on the root SSID). D-Link's libmib
  (`apply_11r` 0x1fc3dc, `hapd_get_wpa_key_mgmt` 0x1fcbe8) adds FT-PSK and
  FT-SAE for WPA2, WPA/WPA2, WPA3 and WPA2+WPA3 (the SDK copy in ~/Public/rsdk
  is older: WPA2 only).
* Band steering: `WIFI_STA_CONTROL` bit 0 on, bit 1 prefer 2.4 GHz
  (`wlan_manager`). Only when both main SSIDs have the same name and
  security (`rtk_wlan_get_band_steering_status`); libmib clears bit 0 when
  they differ. The Wireless page sets bit 0 whenever they match.
* TWT: not available, BSS colouring: added by NijikaWrt (hostapd wrapper).
  Details and the test: [WIFI.md](WIFI.md).
* `flash all` reads the flash tool's copy of the committed configuration
  (`_mib_get`), `flash set` goes through configd, which delays the commit:
  right after a write, `flash all` still shows the old value. uci-mirror runs
  `mib commit cs now` between its writes and the read-back.
* WPS (hostapd): enable is the root record's `wsc_disabled` (and
  `WSC_DISABLE` / `WLAN1_WSC_DISABLE`); `hostapd_cli wps_pbc -i wlanX`,
  `hostapd_cli wps_pin any <pin> -i wlanX`.

## EasyMesh "auto" and the WPS button

The stock `systemd` (Realtek's, not the init system) reads the buttons
(`read_device_event`, 0x40bdf0): the WPS key (0x211) with `MAP_CONTROLLER`
3 (auto, the D-Link/TM default) first picks a role, controller when `nas0`
has link, otherwise **agent** (`setupMultiAPAgent`, name MeshAgent_xxxx,
`DHCP_MODE` 3: the LAN becomes a DHCP client, udhcpd is stopped,
`config_WLAN`, committed) and then runs WPS on the backhaul station
(`wlan0-vxd`). TM's way to turn a spare ONT into a mesh node; on the
gateway it cuts the LAN off. `/usr/libexec/rtk/easymesh-pin` keeps the role
at `nijika.vendor.easymesh` (controller by default; disabled; auto = leave
it) at boot before the WiFi starts (`rtk-apply easymesh ... norestart`) and
on a settings change, and puts `DHCP_MODE` back to 2 after an agent.

## Port forwarding (formPortFw, PORT_FW_TBL)

Record fields: `IP`, `PortStart`/`PortEnd` (internal), `externalportStart`/
`externalportEnd` (0: the internal ones), `Protocol` (1 TCP, 2 UDP, 3 both:
D-Link maps the form's "4" to 3), `remotehost`, `OutInf` (WAN ifIndex,
65535 any), `Comment` (59 characters), `enable`, `Dynamic` (UPnP, not
editable). The stock page adds up to 12 rules per submit; the table's size
is libmib's (`flash all`, MIB Chain Information; SDK: 8, 32 in the TRUE
build). rpcd `portfw_set` rewrites the static rules with `flash del/add/set`
(TM build: through configd, committed) and runs `rtk-apply portfw`.

## IP QoS (Advance > QoS pages, IP_QOS_* tables)

LuCI Network > QoS writes what the stock V1.1.2 forms write (rpcd
`qos_get` / `qos_set`, `/usr/lib/nijika/qos.sh`), checked against the
stock `boa` (form handlers above; record layouts from the `flash` tool's
member tables, MIB ids from its MIB table):

| Page | Keys (MIB id) |
|---|---|
| Upstream QoS Policy | `qosen` `ENABLE_QOS` (144), `enable_force_weight` `TOTAL_BANDWIDTH_LIMIT` (149), `enable_dscp_remark` `ENABLE_DSCP_MARK` (151), `enable_1p_remark` `ENABLE_1P` (152: 0 disable, 1 transparent, 2 translate), `policy=` `QOS_POLICY` (147: 0 strict priority, 1 WRR, 2 CAR), `IP_QOS_QUEUE_TBL` (8 records): `w<i>` is `weight` (WRR) or `car` (CAR), `qen<i>` `enable` (a WRR queue of weight 0 is off) |
| Downstream QoS Policy | the same as `ENABLE_DOWNSTREAM_QOS` (491), `TOTAL_DOWNSTREAM_BANDWIDTH_LIMIT` (493), `ENABLE_DOWNSTREAM_DSCP_MARK` (496), `ENABLE_DOWNSTREAM_1P` (497), `QOS_DOWNSTREAM_POLICY` (494: 0, 1), `IP_QOS_DOWNSTREAM_QUEUE_TBL`: `wifiq<i>` `wifiPrior` (strict priority; 0 background, 1 best effort, 2 video, 3 voice) or `w<i>` `weight` (WRR) |
| Traffic Shaping | total bandwidth Apply: `TOTAL_BANDWIDTH` (148, kbit/s) and the limit on, Clear: the limit off (the policy pages' switch is the same key); `IP_QOS_TC_TBL` rules: `entryid` (lowest free 1..255), `ifIndex`, `IPVersion` (1, 2, 3 both), `direction`, `protocol` (0 none, 1 TCP, 2 UDP, 3 ICMP), addresses with prefix lengths, `srcport`, `dstport`, `rate` (kbit/s, a multiple of 512) |

Classification records (`IP_QOS_TBL`, D-Link's parser 0x43f1c0, record 371
bytes): `Protocol` is a bit mask of the page's checkboxes (TCP 1, UDP 2,
ICMP 4, RTP 8; the SDK's enum does not apply), the connection type goes to
`applicationtype` as bits (TR069 1, INTERNET 2, IPTV 4, VOICE 8; the
list's TR069_INTERNET 3, TR069_VOICE 9, VOICE_INTERNET 10,
TR069_VOICE_INTERNET 11), `classtype` 0 flow based, 1 connection type
based. `qosDscp` / `m_dscp` hold the page's DSCP codes ((DSCP << 2) | 1, 0
none), `vlan1p` / `m_1p` 802.1p + 1, `PhyPort` LAN1-4 as 1-4, masks as
prefix lengths, `SMac` / `DMac` 12 hex digits, `OutInf` the WAN ifIndex
(65535 any), `Prior` the queue (1-8), `Enable` 1. Rules are applied by
`QoSOrder` (0 first); the stock add gives the new rule 0 and moves the
others up (`UpdateQoSOrder`), so `qos_set` gives rule i of n the order
n-1-i, as a series of stock adds would.

`flash set` takes several key/value pairs and prints `set KEY=VALUE` for
each one it took; its exit code is 0 even for a key it refused.
