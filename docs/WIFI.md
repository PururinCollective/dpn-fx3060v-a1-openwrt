# WiFi on the DPN-FX3060V A1

The radios are run by the stock Realtek stack inside `/rtk`: the `rtk_wifi6`
driver (RTL8852CE for 5 GHz, RTL8192XBE for 2.4 GHz, AX3000 class),
hostapd 2.10, and libmib, which writes `/var/hostapd.conf.<radio>` from the
stock configuration and (re)starts hostapd (`config_WLAN`). NijikaWrt sets
the stock configuration (Network > Wireless, `/etc/config/rtk`) and, where
the stock firmware leaves a feature out, adds it around the stock programs.

Findings below were checked on the stock V1.1.2 binaries (libmib, hostapd,
`rtk_wifi6.ko`) and on the test unit; the Realtek SDK sources in
`~/Public/rsdk` are older than the stock firmware in places (802.11r).

## Feature support

| Feature | Status | How |
|---|---|---|
| 802.11ax (WiFi 6) | yes | band bits 128 (`WLAN_BAND`, `WLAN1_BAND`, records' `wlanBand`) |
| 802.11ax only / no legacy | yes | band 128 (ax only), 136/138 on 2.4 GHz, 192/200 on 5 GHz; libmib writes `/proc/net/rtk_wifi6/<if>/deny_legacy` |
| OFDMA | yes | `WLAN_OFDMA_ENABLED` / `WLAN1_OFDMA_ENABLED` (driver mib `ofdma_enable`); NijikaWrt default on |
| TX beamforming | yes (stock on) | driver mib `txbf` = 1; MU (`txbf_mu`) 0 |
| WPA3 (SAE), WPA2+WPA3, PMF | yes | per SSID `encrypt` 16 / 20, `dotIEEE80211W`, `sae_pwe` |
| 802.11r fast roaming | yes, WPA2 and WPA3 | per SSID `WLAN_FT_ENABLE`; libmib `apply_11r` (0x1fc3dc) covers encrypt 4, 6, 16, 20 and adds FT-PSK / FT-SAE (`hapd_get_wpa_key_mgmt`, 0x1fcbe8); seen in the live `wpa_key_mgmt` |
| 802.11k / 802.11v | yes | per SSID `rm_activated`, `BssTransEnable` |
| Band steering | only with the same SSID | `WIFI_STA_CONTROL` (bit 0 on, bit 1 prefer 2.4 GHz), `wlan_manager`; only when both main SSIDs have the same name and security (`rtk_wlan_get_band_steering_status`), libmib switches it off otherwise; the Wireless page switches it on when they match |
| EasyMesh | yes | `MAP_CONTROLLER`; NijikaWrt pins the controller role (`nijika.vendor.easymesh`, see BOA.md) |
| WPS | yes | `hostapd_cli wps_pbc` / `wps_pin`, enable via the root SSID's `wsc_disabled` |
| BSS colouring | added by NijikaWrt | not in the stock configuration (see below) |
| TWT | **no** | not supported by the driver (see below) |

## BSS colouring

libmib never writes `he_bss_color`, so hostapd 2.10 leaves BSS colouring
disabled (its default). hostapd takes the setting (`set he_bss_color N` on
the control socket was accepted, the APs restarted with it), and the driver
has the code to program it (`HE_operation_handler`,
`rtw_hal_bb_set_bss_color`, `halbb_set_bss_color_8852c` / `_8192xb`).

NijikaWrt therefore adds it: the stock `/bin/hostapd` is a wrapper
(`rtk/bin/hostapd`, real binary in `/lib/nijika/hostapd`) that appends
`he_bss_color=<1..63>` to the config libmib wrote, one colour per radio
from the last byte of its BSSID, when `nijika.wifi.bss_color_<radio>` is on
(default; Network > Wireless > Advanced). Turning it off or on restarts WiFi.

Not verified on air yet: the driver does not log the colour it uses. A scan
from a Linux client shows it (no monitor mode needed):

```
sudo iw dev <wifi interface> scan | grep -E "SSID: |BSS Color"
```

## TWT (Target Wake Time): not available

Tried on the test unit (r27, 2026-10-16), at runtime only:

1. The driver has a mib `twt_enable`, 0 on both radios; libmib never sets it.
   `iwpriv wlan0|wlan1 set_mib twt_enable=1` is accepted (`get_mib` reads 1,
   and it survives a WiFi restart).
2. The AP's HE MAC capabilities (`/proc/net/rtk_wifi6/<if>/ap_info`,
   `he_cap` byte 0) stay `0x23`: TWT requester set, **TWT responder not
   set**, before and after, also after the WiFi restart.
3. hostapd accepted `set he_twt_responder 1`, but hostapd can only clear the
   responder bit, not add one the driver does not report.
4. The driver says why: its PHL layer has a TWT capability flag `twt_sup`
   that is false on this hardware/firmware, and every TWT entry point bails
   out ("rtw_phl_twt_...(): twt_sup == false", "AP does not support TWT
   responder").

So an access point on this unit cannot offer TWT, whatever the mib says;
that is fixed in the stock driver (and its firmware). The `twt_enable` mib
is not set by NijikaWrt (it changes nothing; a reboot clears the test
value). TWT matters mostly for battery-powered WiFi 6 clients (IoT,
phones in standby); they fall back to normal power save.
