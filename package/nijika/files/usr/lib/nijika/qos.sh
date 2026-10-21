# shellcheck shell=ash
# Stock IP QoS (Advance > Upstream / Downstream QoS Policy, QoS
# Classification, Traffic Shaping): the records the stock V1.1.2 boa forms
# write (docs/BOA.md, IP QoS). Values in the encoding the forms use:
#
#   classification (IP_QOS_TBL, D-Link parser 0x43f1c0)
#     Protocol      bits: 1 TCP, 2 UDP, 4 ICMP, 8 RTP (the page's checkboxes)
#     applicationtype  connection type: 1 TR069, 2 INTERNET, 4 IPTV, 8 VOICE
#                   and their sums 3, 9, 10, 11 (TR069_INTERNET, TR069_VOICE,
#                   VOICE_INTERNET, TR069_VOICE_INTERNET); 0 none
#     qosDscp, m_dscp  0 none, else (DSCP << 2) | 1 (the page's DSCP list)
#     vlan1p, m_1p  0 none, else 802.1p + 1
#     PhyPort       0 any, 1-4 LAN1-4
#     OutInf        WAN ifIndex, 65535 any
#     masks         prefix length (the page's dotted mask, as bits)
#     QoSOrder      evaluation order, 0 first: a rule the stock page adds
#                   gets 0 and the older ones move up (UpdateQoSOrder), so
#                   rule i of n has n-1-i
#   traffic shaping (IP_QOS_TC_TBL, parser 0x4404f0)
#     entryid       1..255, protocol 0 none, 1 TCP, 2 UDP, 3 ICMP,
#     rate          kbit/s, a multiple of 512 (the meter's step)
#
# qos_rule_fields / qos_tc_fields read the r_* variables of one rule and
# print its record as "Field=value" lines (only fields that differ from a
# new, zeroed record); invalid input: a message on stderr, return 1.

# the scalars of the four pages
QOS_KEYS="ENABLE_QOS QOS_POLICY TOTAL_BANDWIDTH_LIMIT TOTAL_BANDWIDTH ENABLE_DSCP_MARK ENABLE_1P
ENABLE_DOWNSTREAM_QOS QOS_DOWNSTREAM_POLICY TOTAL_DOWNSTREAM_BANDWIDTH_LIMIT TOTAL_DOWNSTREAM_BANDWIDTH
ENABLE_DOWNSTREAM_DSCP_MARK ENABLE_DOWNSTREAM_1P"

qos_uint() { # value max
	case "$1" in ''|*[!0-9]*) return 1 ;; esac
	[ "${#1}" -le 10 ] && [ "$1" -le "$2" ]
}

qos_ip4() {
	echo "$1" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || return 1
	local IFS=. o
	for o in $1; do [ "$o" -le 255 ] || return 1; done
}

qos_ip6() {
	echo "$1" | grep -qiE '^[0-9a-f:]+$' && case "$1" in *:*) return 0 ;; esac
	return 1
}

# MAC "aa:bb:cc:dd:ee:ff" (or "-" separated) -> the flash form, 12 hex digits
qos_mac() {
	local m
	m=$(echo "$1" | tr -d ':-' | tr 'A-F' 'a-f')
	echo "$m" | grep -qE '^[0-9a-f]{12}$' || return 1
	echo "$m"
}

qos_dscp() { # 0 or (DSCP << 2) | 1
	qos_uint "$1" 253 && { [ "$1" = 0 ] || [ $(($1 & 3)) = 1 ]; }
}

qos_bad() {
	echo "$1" >&2
	return 1
}

# field NAME VALUE: print it unless it is the zeroed record's value
qos_out() {
	case "$2" in ''|0|0.0.0.0|::|000000000000) ;; *) echo "$1=$2" ;; esac
}

# qos_mib_ok KEY VALUE: one of QOS_KEYS with a value the stock pages write
# (policy: upstream 0 strict priority, 1 WRR, 2 CAR; downstream 0, 1;
# 802.1p remark 0 disable, 1 transparent, 2 translate; bandwidth in kbit/s)
qos_mib_ok() {
	case "$1" in
		ENABLE_QOS|TOTAL_BANDWIDTH_LIMIT|ENABLE_DSCP_MARK|ENABLE_DOWNSTREAM_QOS|\
		TOTAL_DOWNSTREAM_BANDWIDTH_LIMIT|ENABLE_DOWNSTREAM_DSCP_MARK|QOS_DOWNSTREAM_POLICY)
			case "$2" in 0|1) ;; *) return 1 ;; esac ;;
		QOS_POLICY|ENABLE_1P|ENABLE_DOWNSTREAM_1P)
			case "$2" in 0|1|2) ;; *) return 1 ;; esac ;;
		TOTAL_BANDWIDTH|TOTAL_DOWNSTREAM_BANDWIDTH)
			qos_uint "$2" 10000000 && [ "$2" -gt 0 ] ;;
		*) return 1 ;;
	esac
}

# qos_queue_fields up|down POLICY: r_enable r_weight r_car (upstream CAR,
# kbit/s) r_wifi (downstream WLAN priority: 0 background, 1 best effort,
# 2 video, 3 voice) -> the fields formUpstreamQosPolicy /
# formDownstreamQosPolicy write: the WRR weight, the CAR rate or the WLAN
# priority, whichever the policy uses; a WRR queue of weight 0 is off.
qos_queue_fields() {
	local en=0
	case "${r_enable:-0}" in 1|true) en=1 ;; esac
	qos_uint "${r_weight:-0}" 100 || qos_bad "WRR weight" || return 1
	qos_uint "${r_car:-0}" 10000000 || qos_bad "CAR" || return 1
	qos_uint "${r_wifi:-0}" 3 || qos_bad "Wlan Priority" || return 1
	case "$1:$2" in
		up:1|down:1) echo "weight=${r_weight:-0}"; [ "${r_weight:-0}" = 0 ] && en=0 ;;
		up:2) echo "car=${r_car:-0}" ;;
		down:0) echo "wifiPrior=${r_wifi:-0}" ;;
		up:0) ;;
		*) qos_bad "QoS Policy" || return 1 ;;
	esac
	echo "enable=$en"
}

# r_name r_direction (0 up, 1 down) r_ipver (1 IPv4, 2 IPv6) r_classtype
# (0 flow based, 1 connection type) r_conntype (applicationtype) r_phyport
# r_proto r_dscp r_vlan1p r_outif r_sip r_smask r_dip r_dmask r_sip6
# r_sip6len r_dip6 r_dip6len r_sport r_sport_end r_dport r_dport_end r_smac
# r_dmac r_prio (queue 1-8) r_mdscp r_m1p, r_order
qos_rule_fields() {
	local smac dmac p
	echo "$r_name" | grep -qE '^[A-Za-z0-9_]{1,63}$' || qos_bad "rule name: letters, digits and _" || return 1
	case "$r_direction" in 0|1) ;; *) qos_bad "direction" || return 1 ;; esac
	case "$r_ipver" in 1|2) ;; *) qos_bad "IP version" || return 1 ;; esac
	case "$r_classtype" in 0|1) ;; *) qos_bad "classify rule type" || return 1 ;; esac
	case "${r_conntype:-0}" in 0|1|2|3|4|8|9|10|11) ;; *) qos_bad "connection type" || return 1 ;; esac
	qos_uint "${r_prio:-}" 8 && [ "$r_prio" -ge 1 ] || qos_bad "priority queue" || return 1
	qos_uint "${r_phyport:-0}" 4 || qos_bad "phy port" || return 1
	qos_uint "${r_proto:-0}" 15 || qos_bad "protocol" || return 1
	qos_dscp "${r_dscp:-0}" && qos_dscp "${r_mdscp:-0}" || qos_bad "DSCP" || return 1
	qos_uint "${r_vlan1p:-0}" 8 && qos_uint "${r_m1p:-0}" 8 || qos_bad "802.1p" || return 1
	qos_uint "${r_outif:-65535}" 4294967295 || qos_bad "WAN interface" || return 1
	qos_uint "${r_order:-0}" 255 || qos_bad "order" || return 1
	for p in "${r_sport:-0}" "${r_sport_end:-0}" "${r_dport:-0}" "${r_dport_end:-0}"; do
		qos_uint "$p" 65535 || qos_bad "port" || return 1
	done
	if [ "${r_sport:-0}${r_sport_end:-0}${r_dport:-0}${r_dport_end:-0}" != 0000 ] && [ $((${r_proto:-0} & 3)) = 0 ]; then
		qos_bad "Please don't set Port when protocol is not TCP/UDP!" || return 1
	fi
	smac=000000000000 dmac=000000000000
	[ -z "$r_smac" ] || smac=$(qos_mac "$r_smac") || qos_bad "source MAC" || return 1
	[ -z "$r_dmac" ] || dmac=$(qos_mac "$r_dmac") || qos_bad "destination MAC" || return 1
	if [ "$r_ipver" = 1 ]; then
		[ -z "$r_sip" ] || qos_ip4 "$r_sip" || qos_bad "source IPv4 address" || return 1
		[ -z "$r_dip" ] || qos_ip4 "$r_dip" || qos_bad "destination IPv4 address" || return 1
		qos_uint "${r_smask:-0}" 32 && qos_uint "${r_dmask:-0}" 32 || qos_bad "IPv4 mask" || return 1
	else
		[ -z "$r_sip6" ] || qos_ip6 "$r_sip6" || qos_bad "source IPv6 address" || return 1
		[ -z "$r_dip6" ] || qos_ip6 "$r_dip6" || qos_bad "destination IPv6 address" || return 1
		qos_uint "${r_sip6len:-0}" 128 && qos_uint "${r_dip6len:-0}" 128 || qos_bad "IPv6 prefix length" || return 1
	fi
	if [ "$r_classtype" = 0 ] && [ "${r_phyport:-0}${r_proto:-0}${r_dscp:-0}${r_vlan1p:-0}" = 0000 ] &&
		[ -z "$r_sip$r_dip$r_sip6$r_dip6$r_smac$r_dmac" ] &&
		[ "${r_sport:-0}${r_dport:-0}" = 00 ] && [ "${r_outif:-65535}" = 65535 ]; then
		qos_bad "Please set rule match information!" || return 1
	fi
	if [ "$r_classtype" = 1 ] && [ "${r_conntype:-0}" = 0 ]; then
		qos_bad "connection type" || return 1
	fi

	echo "Name=$r_name"
	qos_out direction "$r_direction"
	echo "IPVersion=$r_ipver"
	qos_out classtype "$r_classtype"
	echo "Enable=1"
	echo "Prior=$r_prio"
	echo "OutInf=${r_outif:-65535}"
	qos_out QoSOrder "${r_order:-0}"
	qos_out m_dscp "${r_mdscp:-0}"
	qos_out m_1p "${r_m1p:-0}"
	# connection type based: only the type (the stock page clears the rest)
	if [ "$r_classtype" = 1 ]; then
		echo "applicationtype=$r_conntype"
		return 0
	fi
	qos_out PhyPort "${r_phyport:-0}"
	qos_out Protocol "${r_proto:-0}"
	qos_out qosDscp "${r_dscp:-0}"
	qos_out vlan1p "${r_vlan1p:-0}"
	if [ "$r_ipver" = 1 ]; then
		qos_out SrcIP "$r_sip"
		qos_out SrcMask "${r_smask:-0}"
		qos_out DstIP "$r_dip"
		qos_out DstMask "${r_dmask:-0}"
	else
		qos_out SrcIP6 "$r_sip6"
		qos_out SrcIP6PrefixLen "${r_sip6len:-0}"
		qos_out DstIP6 "$r_dip6"
		qos_out DstIP6PrefixLen "${r_dip6len:-0}"
	fi
	qos_out SrcPort "${r_sport:-0}"
	qos_out SrcPortRangeMax "${r_sport_end:-0}"
	qos_out DstPort "${r_dport:-0}"
	qos_out DstPortRangeMax "${r_dport_end:-0}"
	qos_out SMac "$smac"
	qos_out DMac "$dmac"
}

# r_entryid r_ipver (1 IPv4, 2 IPv6, 3 both) r_direction r_proto r_ifindex
# r_sip r_smask r_dip r_dmask r_sip6 r_sip6len r_dip6 r_dip6len r_sport
# r_dport r_rate
qos_tc_fields() {
	qos_uint "${r_entryid:-}" 255 && [ "$r_entryid" -ge 1 ] || qos_bad "ID" || return 1
	case "$r_ipver" in 1|2|3) ;; *) qos_bad "IP version" || return 1 ;; esac
	case "$r_direction" in 0|1) ;; *) qos_bad "direction" || return 1 ;; esac
	case "${r_proto:-0}" in 0|1|2|3) ;; *) qos_bad "protocol" || return 1 ;; esac
	qos_uint "${r_ifindex:-65535}" 4294967295 || qos_bad "WAN interface" || return 1
	qos_uint "${r_sport:-0}" 65535 && qos_uint "${r_dport:-0}" 65535 || qos_bad "port" || return 1
	qos_uint "${r_rate:-}" 4294967295 && [ "$r_rate" -gt 0 ] && [ $((r_rate % 512)) = 0 ] ||
		qos_bad "Speed rate ${r_rate}kbs is invalid! Please enter the multiple of 512!" || return 1
	if [ "$r_ipver" != 2 ]; then
		[ -z "$r_sip" ] || qos_ip4 "$r_sip" || qos_bad "source IPv4 address" || return 1
		[ -z "$r_dip" ] || qos_ip4 "$r_dip" || qos_bad "destination IPv4 address" || return 1
		qos_uint "${r_smask:-0}" 32 && qos_uint "${r_dmask:-0}" 32 || qos_bad "IPv4 mask" || return 1
	fi
	if [ "$r_ipver" != 1 ]; then
		[ -z "$r_sip6" ] || qos_ip6 "$r_sip6" || qos_bad "source IPv6 address" || return 1
		[ -z "$r_dip6" ] || qos_ip6 "$r_dip6" || qos_bad "destination IPv6 address" || return 1
		qos_uint "${r_sip6len:-0}" 128 && qos_uint "${r_dip6len:-0}" 128 || qos_bad "IPv6 prefix length" || return 1
	fi

	echo "entryid=$r_entryid"
	echo "ifIndex=${r_ifindex:-65535}"
	echo "IPVersion=$r_ipver"
	qos_out direction "$r_direction"
	qos_out protocol "${r_proto:-0}"
	echo "rate=$r_rate"
	if [ "$r_ipver" != 2 ]; then
		qos_out Srcip "$r_sip"
		qos_out srcmask "${r_smask:-0}"
		qos_out dstip "$r_dip"
		qos_out dstmask "${r_dmask:-0}"
	fi
	if [ "$r_ipver" != 1 ]; then
		qos_out SrcIP6 "$r_sip6"
		qos_out SrcIP6PrefixLen "${r_sip6len:-0}"
		qos_out DstIP6 "$r_dip6"
		qos_out DstIP6PrefixLen "${r_dip6len:-0}"
	fi
	qos_out srcport "${r_sport:-0}"
	qos_out dstport "${r_dport:-0}"
}
