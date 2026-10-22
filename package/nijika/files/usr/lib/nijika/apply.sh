# SPDX-License-Identifier: GPL-2.0-only

# shellcheck shell=ash
# Live apply of stock configuration changes: after writing a key with
# `flash set`, make the running vendor stack follow it the way the stock web
# form for that key does (docs/BOA.md). /rtk/bin/rtk-apply makes the libmib
# calls of the boa form handlers. Sourced after common.sh.
#
#   apply_area KEY        area of a flash key (see below)
#   apply_before AREA...  before the keys are written (a WAN connection is
#                         taken down with its old settings)
#   apply_after AREA...   after writing; returns 1 when an area needs a reboot
#
# Areas, in the order they are applied:
#   wanmode:<n> connection mode of record n changed: rtk-apply wan-mode
#             (dependent services, PPP unit) before wan:<n> brings it up
#   wan:<n>   ATM_VC_TBL record n         boa formEth
#   port:<n>  LAN port n on/off           formTcpipLanSetup (SW_PORT_TBL.<n>.Enable)
#   firewall  filters, SPI, DMZ           formFilter, formFilterV6, formDMZ
#   portfw    port forwarding             formPortFw
#   qos       QoS policies, classification, traffic shaping
#                                         formUpstreamQosPolicy, formDownstreamQosPolicy,
#                                         formQosRule, formQosTraffictl
#   lan       LAN address, DHCP server    formTcpipLanSetup, formDhcpd
#   snooping  IGMP/MLD snooping (MP_MODE) formTcpipLanSetup
#   wlanblock LAN <-> WiFi blocking       formTcpipLanSetup
#   upnp      UPnP daemon, its WAN        formUpnp
#   wlan      WiFi                        formWlanSetup, formWlEncrypt
#   loid      LOID + password             formgponConf
#   ploam     PLOAM password              formgponConf
#   omci      device type, OLT mode       formgponConf (restartOMCIsettings)
#   voip      VoIP (voipflashcmd)         web_restart_solar
#   reboot    anything else: read by the stock services when they start
#
# nijika.vendor.live_apply=0 turns it off: every change waits for a reboot.

apply_enabled() {
	[ "$(uci -q get nijika.vendor.live_apply)" != 0 ]
}

# rtk_apply COMMAND [ARG]  (only the command is logged: ARG may be a secret)
rtk_apply() {
	logger -t rtk-apply "$1${2:+ ...}"
	rtk /bin/rtk-apply "$@" >/dev/null 2>&1
}

apply_area() {
	case "$1" in
		ATM_VC_TBL.*)
			set -- "${1#ATM_VC_TBL.}"
			case "$1" in *.ChannelMode) echo "wanmode:${1%%.*}" ;; esac
			echo "wan:${1%%.*}" ;;
		SW_PORT_TBL.*.Enable)
			set -- "${1#SW_PORT_TBL.}"
			echo "port:${1%%.*}" ;;
		MP_MODE)
			echo snooping ;;
		WLAN_BLOCK_ETH2WIR)
			echo wlanblock ;;
		UPNP|UPNP_EXT_ITF)
			echo upnp ;;
		IPF_*|V6_IPF_*|MACF_*|DMZ_*|IPFILTER_SPI_ENABLE|V6_SESSION_FW_ENABLE|\
		IP_PORT_FILTER_TBL*|V6_IP_PORT_FILTER_TBL*|MAC_FILTER_TBL*|MAC_FILTER_EBTABLES_ENABLE)
			echo firewall ;;
		PORT_FW_ENABLE|PORT_FW_TBL*)
			echo portfw ;;
		ENABLE_QOS|QOS_POLICY|TOTAL_BANDWIDTH|TOTAL_BANDWIDTH_LIMIT|ENABLE_DSCP_MARK|ENABLE_1P|\
		ENABLE_DOWNSTREAM_*|QOS_DOWNSTREAM_POLICY|TOTAL_DOWNSTREAM_BANDWIDTH*|IP_QOS_*)
			echo qos ;;
		LAN_IP_ADDR|LAN_SUBNET|LAN_IP_ADDR2|LAN_SUBNET2|LAN_ENABLE_IP2|LAN_DHCP*|DHCP_MODE|DHCPS_*|DHCP_SUBNET_MASK)
			echo lan ;;
		WLAN_*|WLAN1_*|WSC_*|SSID|CHANNEL|AUTO_CHANNEL*|HIDDEN_SSID|BEACON_INTERVAL|DTIM_PERIOD|WIFI_STA_CONTROL|MAP_*)
			echo wlan ;;
		LOID|LOID_PASSWD)
			echo loid ;;
		GPON_PLOAM_PASSWD)
			echo ploam ;;
		DEVICE_TYPE|OMCI_OLT_MODE)
			echo omci ;;
		*)
			echo reboot ;;
	esac
}

# apply_areas: flash keys (stdin, one per line) -> their areas, unique, in
# apply order (one line)
apply_areas() {
	while IFS= read -r k; do apply_area "$k"; done | awk '
		{ seen[$0] = 1 }
		END {
			n = split("firewall portfw qos lan snooping wlanblock upnp wlan loid ploam omci voip reboot", order, " ")
			for (a in seen) if (a ~ /^wanmode:/) out = out " " a
			for (a in seen) if (a ~ /^wan:/) out = out " " a
			for (a in seen) if (a ~ /^port:/) out = out " " a
			for (i = 1; i <= n; i++) if (order[i] in seen) out = out " " order[i]
			print substr(out, 2)
		}'
}

apply_before() {
	local a
	apply_enabled || return 0
	for a in "$@"; do
		case "$a" in
			wan:*) rtk_apply wan-down "${a#wan:}" ;;
			qos) rtk_apply qos-stop ;;
		esac
	done
}

# GPON as formgponConf: the LOID goes to OMCI at once, a new PLOAM
# password re-registers, a change of LOID, device type or OLT mode ends
# with restartOMCIsettings.
apply_after() {
	local a loid pw omci=0 reboot=0
	if ! apply_enabled; then
		[ $# -eq 0 ]
		return
	fi
	for a in "$@"; do
		case "$a" in
			wanmode:*) rtk_apply wan-mode "${a#wanmode:}" ;;
			wan:*) rtk_apply wan-up "${a#wan:}" ;;
			port:*) rtk_apply lan-port "${a#port:}" ;;
			snooping) rtk_apply snooping ;;
			wlanblock) rtk_apply wlan-block ;;
			firewall|portfw|qos|lan|upnp|wlan|voip) rtk_apply "$a" ;;
			loid)
				loid=$(mib_get LOID) pw=$(mib_get LOID_PASSWD)
				logger -t rtk-apply "omcicli set loid"
				rtk /bin/omcicli set loid "$loid" ${pw:+"$pw"} >/dev/null 2>&1
				omci=1 ;;
			ploam)
				rtk_apply gpon-ploam "$(mib_get GPON_PLOAM_PASSWD)" ;;
			omci) omci=1 ;;
			reboot) reboot=1 ;;
		esac
	done
	[ $omci = 1 ] && rtk_apply gpon-omci
	return $reboot
}

# wan_delete N: delete WAN connection N (ATM_VC_TBL record N) the way the
# stock PON WAN page does (rtk-apply wan-delete), then give its LAN ports
# and SSIDs (itfGroup) to the connection with the default route when that
# one binds its ports explicitly, so none is left without a connection.
# Records after N move down by one; /etc/config/rtk is rebuilt.
# Returns 2 when there is no record N, 1 when the stock stack refused.
wan_delete() {
	local n="$1" cmode dhcp grp i g
	case "$n" in ''|*[!0-9]*) return 2 ;; esac
	cmode=$(mib_get "ATM_VC_TBL.$n.ChannelMode")
	[ -n "$cmode" ] || return 2
	dhcp=$(mib_get "ATM_VC_TBL.$n.ChannelAddrType")
	grp=$(mib_get "ATM_VC_TBL.$n.itfGroup")
	if [ "$cmode" = 1 ] && [ "$dhcp" = 1 ]; then
		rtk_apply wan-delete "$n" dhcpc || return 1
	else
		rtk_apply wan-delete "$n" || return 1
	fi
	if [ "${grp:-0}" -gt 0 ] 2>/dev/null; then
		i=0
		while [ $i -lt 16 ] && [ -n "$(mib_get "ATM_VC_TBL.$i.ChannelMode")" ]; do
			if [ "$(mib_get "ATM_VC_TBL.$i.DefaultGW")" = 1 ]; then
				g=$(mib_get "ATM_VC_TBL.$i.itfGroup")
				if [ "${g:-0}" -gt 0 ] 2>/dev/null && [ $((g & grp)) -ne "$grp" ]; then
					apply_before "wan:$i"
					mib_set "ATM_VC_TBL.$i.itfGroup" $((g | grp))
					apply_after "wan:$i"
				fi
				break
			fi
			i=$((i + 1))
		done
	fi
	/usr/libexec/rtk/uci-mirror sync >/dev/null 2>&1
	return 0
}
