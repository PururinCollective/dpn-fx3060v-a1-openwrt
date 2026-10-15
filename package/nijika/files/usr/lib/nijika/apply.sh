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
#   wan:<n>   ATM_VC_TBL record n         boa formEth
#   firewall  filters, SPI, DMZ           formFilter, formFilterV6, formDMZ
#   lan       LAN address, DHCP server    formTcpipLanSetup, formDhcpd
#   wlan      WiFi                        formWlanSetup, formWlEncrypt
#   loid      LOID + password             formgponConf
#   ploam     PLOAM password              formgponConf
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
			echo "wan:${1%%.*}" ;;
		IPF_*|V6_IPF_*|MACF_*|DMZ_*|IPFILTER_SPI_ENABLE|V6_SESSION_FW_ENABLE|\
		IP_PORT_FILTER_TBL*|V6_IP_PORT_FILTER_TBL*|MAC_FILTER_TBL*|MAC_FILTER_EBTABLES_ENABLE)
			echo firewall ;;
		LAN_IP_ADDR|LAN_SUBNET|LAN_IP_ADDR2|LAN_SUBNET2|LAN_ENABLE_IP2|LAN_DHCP*|DHCP_MODE|DHCPS_*|DHCP_SUBNET_MASK)
			echo lan ;;
		WLAN_*|WLAN1_*|WSC_*|SSID)
			echo wlan ;;
		LOID|LOID_PASSWD)
			echo loid ;;
		GPON_PLOAM_PASSWD)
			echo ploam ;;
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
			n = split("firewall lan wlan loid ploam voip reboot", order, " ")
			for (a in seen) if (a ~ /^wan:/) out = out " " a
			for (i = 1; i <= n; i++) if (order[i] in seen) out = out " " order[i]
			print substr(out, 2)
		}'
}

apply_before() {
	local a
	apply_enabled || return 0
	for a in "$@"; do
		case "$a" in wan:*) rtk_apply wan-down "${a#wan:}" ;; esac
	done
}

# GPON as formgponConf: the LOID goes to OMCI right away, a new PLOAM
# password re-registers, a LOID change ends with restartOMCIsettings.
apply_after() {
	local a loid pw omci=0 reboot=0
	if ! apply_enabled; then
		[ $# -eq 0 ]
		return
	fi
	for a in "$@"; do
		case "$a" in
			wan:*) rtk_apply wan-up "${a#wan:}" ;;
			firewall|lan|wlan|voip) rtk_apply "$a" ;;
			loid)
				loid=$(mib_get LOID) pw=$(mib_get LOID_PASSWD)
				logger -t rtk-apply "omcicli set loid"
				rtk /bin/omcicli set loid "$loid" ${pw:+"$pw"} >/dev/null 2>&1
				omci=1 ;;
			ploam)
				rtk_apply gpon-ploam "$(mib_get GPON_PLOAM_PASSWD)" ;;
			reboot) reboot=1 ;;
		esac
	done
	[ $omci = 1 ] && rtk_apply gpon-omci
	return $reboot
}
