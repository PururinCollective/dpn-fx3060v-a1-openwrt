#!/bin/sh
# NijikaWrt offline regression tests: no router needed.
#
#   tests/run.sh                 every group
#   tests/run.sh parsers fwu     some groups
#
# Groups: syntax json lint parsers wrapper ucimirror spi lanmgmt apply easymesh ddns wireguard kmod helpers stockshell bootenv fwu banner theme
# Needs busybox (the router's shell and awk) and python3 (JSON checks).
# `fwu` needs a factory image in bin/ (./build.sh). Fixtures in
# tests/fixtures/ are real A1 captures (tools/probe.sh, tools/omci-capture.sh)
# with serials and credentials removed.
#
# The host busybox may be older than the router's: busybox 1.37 awk drops
# backslashes from gsub()/sub() replacement strings, which the `lint` group
# catches statically.

TOP=$(cd "$(dirname "$0")/.." && pwd)
FIX="$TOP/tests/fixtures"
LIB="$TOP/package/nijika/files/usr/lib/nijika"
BB=$(command -v busybox) || { echo "busybox is required"; exit 2; }
PY=$(command -v python3)
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

pass=0 fail=0 skip=0
ok()   { pass=$((pass + 1)); printf '  [+] %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  [x] %s\n' "$1"; [ -n "$2" ] && printf '      %s\n' "$2"; }
skp()  { skip=$((skip + 1)); printf '  [-] %s (skipped: %s)\n' "$1" "$2"; }
# check NAME COMMAND...   (pass when the command succeeds)
check() { n="$1"; shift; if out=$("$@" 2>&1); then ok "$n"; else bad "$n" "$(echo "$out" | tail -n 3 | tr '\n' ' ')"; fi; }
# pyjson NAME FILE EXPR   (python expression over d = the parsed JSON)
pyjson() {
	[ -n "$PY" ] || { skp "$1" "no python3"; return; }
	check "$1" "$PY" -I -c "import json,sys; d=json.load(open(sys.argv[1])); assert eval(sys.argv[2]), 'assertion failed: ' + sys.argv[2]" "$2" "$3"
}

# ----------------------------------------------------------------- syntax

shell_scripts() {
	find "$TOP/package" "$TOP/scripts" "$TOP/firmware" "$TOP/tools" "$TOP/tests" -type f \
		! -path '*/fixtures/*' ! -name '*.py' ! -name '*.js' ! -name '*.json' ! -name '*.awk' \
		! -name '*.md' ! -name 'Makefile' ! -name '*.tsv' ! -name '*.txt' ! -path '*/etc/config/*' |
	while read -r f; do
		case "$(head -c 64 "$f")" in
			'#!/bin/sh'*|'#!/bin/bash'*|'# shellcheck shell='*|'# NijikaWrt'*) echo "$f" ;;
			*) case "$f" in */lib/preinit/*|*/uci-defaults/*|*/post-boot.d/*) echo "$f" ;; esac ;;
		esac
	done
}

t_syntax() {
	echo "syntax"
	local f n=0 bad_files=""
	for f in $(shell_scripts); do
		n=$((n + 1))
		if head -n 1 "$f" | grep -q bash; then
			bash -n "$f" 2>/dev/null || bad_files="$bad_files ${f#$TOP/}"
		else
			"$BB" sh -n "$f" 2>/dev/null || bad_files="$bad_files ${f#$TOP/}"
		fi
	done
	[ -z "$bad_files" ] && ok "$n shell scripts parse" || bad "shell syntax" "$bad_files"
}

# ------------------------------------------------------------------- json

t_json() {
	echo "json"
	[ -n "$PY" ] || { skp "JSON files" "no python3"; return; }
	local f
	for f in "$TOP"/package/luci-app-nijika/root/usr/share/luci/menu.d/*.json \
	         "$TOP"/package/luci-app-nijika/root/usr/share/rpcd/acl.d/*.json \
	         "$TOP"/tools/luci-mock/fixtures/*.json; do
		check "${f#$TOP/}" "$PY" -I -c "import json,sys; json.load(open(sys.argv[1]))" "$f"
	done
}

# ------------------------------------------------------------------- lint

t_lint() {
	echo "lint"
	check "chroot entry closes procd's lock fd 1000 before starting stock programs" sh -c "
		f='$TOP/package/rtk-vendor/files/usr/libexec/rtk/run'
		[ \$(grep -n '^exec 1000>&-' \"\$f\" | cut -d: -f1) -lt \$(grep -n 'chroot \"\$RTK\"' \"\$f\" | cut -d: -f1) ]"
	check "stock slogd replaced (OpenWrt logd keeps /dev/log)" sh -c "
		grep -q 'NijikaWrt placeholder' '$TOP/package/rtk-vendor/files/rtk/bin/slogd' &&
		grep -q 'lib/nijika/slogd' '$TOP/scripts/patch-vendor.sh'"
	# gsub()/sub() whose replacement string holds a backslash: busybox 1.37
	# awk (OpenWrt) drops it ("\\\"" becomes a bare quote, "\\n" an n).
	local hits
	hits=$(grep -rnE 'g?sub\([^)]*,[[:space:]]*"[^"]*\\' "$TOP/package" "$TOP/scripts" "$TOP/firmware" \
		--include='*.awk' --include='*.sh' --include='nijika' --include='*' 2>/dev/null |
		grep -vE '^[^:]*:[0-9]+:[[:space:]]*#' | grep -v '/htdocs/' || true)
	[ -z "$hits" ] && ok "no backslash in gsub()/sub() replacements" || bad "backslash in gsub()/sub() replacement" "$hits"

	# device-specific values belong in devices/<id>/device.conf
	# (comments and the ${VAR:-fallback} defaults for older images excepted)
	hits=$(grep -rnI 'dpn-fx3060v-a1' "$TOP/package" "$TOP/scripts" "$TOP/firmware" |
		awk '{ code = $0; sub(/^[^:]*:[0-9]+:/, "", code); sub(/(^|[ \t])#.*/, "", code)
		       if (code ~ /dpn-fx3060v-a1/ && code !~ /:[-=]dlink,dpn-fx3060v-a1/) print }' || true)
	[ -z "$hits" ] && ok "no hardcoded device id outside devices/ (fallbacks excepted)" || bad "hardcoded device id" "$hits"
}

# ---------------------------------------------------------------- parsers

t_parsers() {
	echo "parsers"
	local a="$BB awk"

	$a -v table=ATM_VC_TBL -f "$LIB/chain.awk" "$FIX/flash-get-atm_vc_tbl.txt" > "$W/chain.json"
	pyjson "chain.awk: 4 WAN records (padded 'field = value' format)" "$W/chain.json" \
		"d['num'] == 4 and len(d['records']) == 4 and d['records'][0]['vid'] == '500' and d['records'][0]['ChannelMode'] == '2' and d['records'][1]['vid'] == '600' and d['records'][3]['applicationtype'] == '1'"

	printf 'X.0:\nssid               =  two spaces\nkey                = a"b\\c\033[1mz\ttab\n' |
		$a -v table=X -f "$LIB/chain.awk" > "$W/chain2.json"
	pyjson "chain.awk: quote, backslash, tab escaped; ANSI dropped; leading space kept" "$W/chain2.json" \
		"d['records'][0]['key'] == 'a\"b\\\\c[1mz\\ttab' and d['records'][0]['ssid'] == ' two spaces'"

	printf 'LAN_IP_ADDR=192.168.0.1\nSSID=a"b\\c\nSSID=dup\nATM_VC_TBL.NUM=4\n  ID Name size\n' |
		$a -f "$LIB/kv.awk" > "$W/kv.json"
	pyjson "kv.awk: KEY=VALUE, first wins, escaping" "$W/kv.json" \
		"d['LAN_IP_ADDR'] == '192.168.0.1' and d['SSID'] == 'a\"b\\\\c' and d['ATM_VC_TBL.NUM'] == '4' and len(d) == 3"

	$a -v class=131 -f "$LIB/me.awk" "$FIX/omci-mib-131.txt" > "$W/131.json"
	pyjson "me.awk 131: multi-line ToDInfo keeps its newline" "$W/131.json" \
		"d['name'] == 'OltG' and [v for k, v in d['instances'][0]['attrs'] if k == 'ToDInfo'][0].count('\\n') == 1"
	$a -v class=171 -f "$LIB/me.awk" "$FIX/omci-mib-171.txt" > "$W/171.json"
	pyjson "me.awk 171: 5 instances, rule table lines in raw" "$W/171.json" \
		"len(d['instances']) == 5 and not d['truncated'] and d['instances'][0]['raw'].count('Filter Outer') == 5"
	$a -v class=84 -f "$LIB/me.awk" "$FIX/omci-mib-84.txt" > "$W/84.json"
	pyjson "me.awk 84: 7 VLAN filters" "$W/84.json" "len(d['instances']) == 7"
	$a -v class=262 -f "$LIB/me.awk" "$FIX/omci-mib-262.txt" > "$W/262.json"
	pyjson "me.awk 262: 31 T-CONTs" "$W/262.json" "len(d['instances']) == 31 and not d['truncated']"
	$a -v class=277 -f "$LIB/me.awk" "$FIX/omci-mib-277.txt" > "$W/277.json"
	pyjson "me.awk 277: omcicli cut-off answer flagged truncated" "$W/277.json" "d['truncated']"
	printf 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\nGemPortCtp\nXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\n' |
		$a -v class=268 -f "$LIB/me.awk" > "$W/268e.json"
	pyjson "me.awk: empty table (no fibre) is complete, not truncated" "$W/268e.json" \
		"d['name'] == 'GemPortCtp' and d['instances'] == [] and not d['truncated']"

	$a -f "$LIB/qmap.awk" "$FIX/omci-dump-qmap.txt" > "$W/qmap.json"
	pyjson "qmap.awk: used queues, T-CONTs with Alloc-ID, flows" "$W/qmap.json" \
		"len(d['pq']) == 5 and len(d['tcont']) == 5 and len(d['us']) == 5 and len(d['ds']) == 7 and {'gem': 284, 'pq': '0x8004', 'flow': 1} in d['us'] and {'tcid': 1, 'meid': '0x8004', 'alloc': 285, 'gems': 1} in d['tcont']"
	# nijika wan: the listing awk of the CLI over the real A1 table
	sed -n '/^nijika_wan() {/,/^}/p' "$TOP/package/nijika/files/usr/sbin/nijika" |
		sed -n "/awk '\$/,/END { flush() }'\$/p" | sed "1d; \$s/'\$//" > "$W/wan.awk"
	"$BB" awk -f "$W/wan.awk" "$FIX/flash-get-atm_vc_tbl.txt" > "$W/wan.out" 2>&1
	check "nijika wan: PON_<VC index>, service, type, VLAN" sh -c "
		grep -qE '^0 +PON_0 +Internet +PPPoE +500 +enabled' '$W/wan.out' &&
		grep -qE '^1 +PON_1 +Other/IPTV +Bridged +600 ' '$W/wan.out' &&
		grep -qE '^2 +PON_2 +VoIP +IPoE +400 ' '$W/wan.out' &&
		grep -qE '^3 +PON_3 +TR-069 +IPoE +209 ' '$W/wan.out'"
	# vprio is the stock priority list index: 1 = 802.1p 0
	sed 's/^vprio *= 0$/vprio              = 1/' "$FIX/flash-get-atm_vc_tbl.txt" | "$BB" awk -f "$W/wan.awk" > "$W/wan1.out"
	check "nijika wan: vprio 1 (stock list index) is priority 0" grep -qE '^0 +PON_0 +Internet +PPPoE +500/p0 ' "$W/wan1.out"
}

# --------------------------------------------- stock dnsmasq DoH wrapper

t_wrapper() {
	echo "wrapper (stock dnsmasq for DNS over HTTPS, TR-069 client, SNMP agent, hostapd)"
	local V="$W/dns"
	mkdir -p "$V/nijika"
	printf '#!/bin/sh\necho "$*" > %s/real.args\n' "$V" > "$V/real"
	chmod +x "$V/real"
	sed -e "s|^REAL=.*|REAL=$V/real|" -e "s|/var/nijika|$V/nijika|g" \
		"$TOP/package/rtk-vendor/files/rtk/bin/dnsmasq" > "$V/wrapper"
	stock() {
		printf '%s\n' 'user=' 'local=/wpad.dlinkrouter.local./' \
			'server=202.188.18.188@175.140.7.54' 'server=2001:e68::b:68@2001:e68::1' \
			'server=/ims.tm.com.my/192.0.2.1@10.198.82.51' 'server=/acs.tm.com.my/172.21.77.221@10.149.115.4' > "$V/dnsmasq.conf"
	}
	run() { "$BB" sh "$V/wrapper" -C "$V/dnsmasq.conf" -r "$V/resolv.conf" --log-facility=/dev/null; }

	stock; echo '127.0.0.1#5053' > "$V/nijika/doh"; run
	check "DoH on: generic upstreams replaced, split DNS (IMS, TR-069) kept" sh -c "
		grep -qx 'server=127.0.0.1#5053' '$V/dnsmasq.conf' && grep -qx no-resolv '$V/dnsmasq.conf' &&
		grep -qx cache-size=1000 '$V/dnsmasq.conf' && ! grep -q '^server=202' '$V/dnsmasq.conf' &&
		! grep -q '^server=2001' '$V/dnsmasq.conf' && grep -q '^server=/ims.tm.com.my/' '$V/dnsmasq.conf' &&
		grep -q '^server=/acs.tm.com.my/' '$V/dnsmasq.conf'"
	check "real dnsmasq started with the stock arguments" grep -q -- "-C $V/dnsmasq.conf -r" "$V/real.args"
	rm -f "$V/nijika/doh"; run
	check "DoH off again: the stock config comes back" sh -c "grep -q '^server=202' '$V/dnsmasq.conf' && ! grep -q nijika-doh '$V/dnsmasq.conf'"
	echo '127.0.0.1#5053' > "$V/nijika/doh"; run
	check "restart without a new stock config: exactly proxy + 2 split servers" \
		sh -c "[ \$(grep -c '^server=' '$V/dnsmasq.conf') -eq 3 ]"

	# TR-069 client / SNMP agent: off unless their switch file exists
	for b in cwmpClient snmpd; do
		sed -e "s|^REAL=.*|REAL=$V/real|" -e "s|/var/nijika|$V/nijika|g" \
			"$TOP/package/rtk-vendor/files/rtk/bin/$b" > "$V/$b"
	done
	rm -f "$V/real.args" "$V/nijika/tr069" "$V/nijika/snmp"
	"$BB" sh "$V/cwmpClient"
	"$BB" sh "$V/snmpd" -r -L -c /var/snmpd.conf -p /var/run/snmpd.pid
	check "TR-069 client and SNMP agent stay off without their switch" sh -c "[ ! -e '$V/real.args' ]"
	: > "$V/nijika/snmp"
	"$BB" sh "$V/snmpd" -r -L -c /var/snmpd.conf -p /var/run/snmpd.pid
	check "SNMP switch on: the real snmpd runs with the stock arguments" \
		grep -qx -- "-r -L -c /var/snmpd.conf -p /var/run/snmpd.pid" "$V/real.args"
	: > "$V/nijika/tr069"; rm -f "$V/real.args"
	"$BB" sh "$V/cwmpClient"
	check "TR-069 switch on: the real cwmpClient runs" test -e "$V/real.args"

	# hostapd: BSS colour from the BSSID's last byte when the radio's
	# switch exists, once; the real hostapd gets the stock arguments
	sed -e "s|^REAL=.*|REAL=$V/real|" -e "s|^SW=.*|SW=$V/nijika|" \
		"$TOP/package/rtk-vendor/files/rtk/bin/hostapd" > "$V/hostapd"
	printf '%s\n' 'interface=wlan0' 'ssid=test' 'bssid=c8:78:7d:61:5a:2f' 'bss=wlan0-vap0' 'bssid=c8:78:7d:61:5a:30' > "$V/hostapd.conf.wlan0"
	cp "$V/hostapd.conf.wlan0" "$V/stock.conf"
	cp "$V/hostapd.conf.wlan0" "$V/hostapd.pid.wlan0"	# a pid file that looks like a config
	rm -f "$V/real.args" "$V/nijika/bss_color.wlan0"
	"$BB" sh "$V/hostapd" "$V/hostapd.conf.wlan0" -s -g /var/run/hostapd/global.wlan0 -B -P "$V/hostapd.pid.wlan0"
	check "BSS colouring off: hostapd config left as libmib wrote it" cmp -s "$V/hostapd.conf.wlan0" "$V/stock.conf"
	: > "$V/nijika/bss_color.wlan0"
	"$BB" sh "$V/hostapd" "$V/hostapd.conf.wlan0" -s -g /var/run/hostapd/global.wlan0 -B -P "$V/hostapd.pid.wlan0"
	"$BB" sh "$V/hostapd" "$V/hostapd.conf.wlan0" -s -g /var/run/hostapd/global.wlan0 -B -P "$V/hostapd.pid.wlan0"
	check "BSS colouring on: colour 48 (0x2f % 63 + 1) added once, only to the config" sh -c "
		[ \$(grep -c '^he_bss_color=48\$' '$V/hostapd.conf.wlan0') -eq 1 ] &&
		[ \$(wc -l < '$V/hostapd.conf.wlan0') -eq 6 ] && cmp -s '$V/hostapd.pid.wlan0' '$V/stock.conf'"
	check "real hostapd started with the stock arguments" grep -qx -- "$V/hostapd.conf.wlan0 -s -g /var/run/hostapd/global.wlan0 -B -P $V/hostapd.pid.wlan0" "$V/real.args"
}

# ------------------------------------------------- /etc/config/rtk quoting

t_ucimirror() {
	echo "ucimirror (/etc/config/rtk quoting)"
	local f="$TOP/package/rtk-vendor/files/usr/libexec/rtk/uci-mirror"
	{
		sed -n '/^to_uci()/,/^}/p' "$f"
		sed -n '/^from_uci()/,/^}/p' "$f" | sed 's|/sbin/uci -q -c "$UCI_DIR" show rtk|cat "$UCI_SHOW"|'
		sed -n '/^changed()/,/^}/p' "$f"
	} > "$W/um.sh"
	printf '%s\n' "mib.LAN_IP_ADDR=192.168.0.1" "mib.Q=a'b c" "ATM_VC_TBL_0.vid=500" > "$W/um.in"
	"$BB" sh -c ". '$W/um.sh'; to_uci < '$W/um.in'" > "$W/um.conf"
	check "to_uci: sections and quoting" sh -c "
		grep -qx \"config mib 'mib'\" '$W/um.conf' && grep -qx \"config ATM_VC_TBL 'ATM_VC_TBL_0'\" '$W/um.conf' &&
		grep -qxF \"	option Q 'a'\\\\''b c'\" '$W/um.conf'"
	printf '%s\n' "rtk.mib=mib" "rtk.mib.LAN_IP_ADDR='192.168.0.2'" "rtk.mib.Q='a'\\''b c'" "rtk.ATM_VC_TBL_0.vid='500'" > "$W/um.show"
	UCI_SHOW="$W/um.show" "$BB" sh -c ". '$W/um.sh'; from_uci" > "$W/um.cur"
	check "from_uci: unquotes uci show (quote inside a value)" grep -qxF "mib.Q=a'b c" "$W/um.cur"
	"$BB" sh -c ". '$W/um.sh'; changed '$W/um.in' '$W/um.cur'" > "$W/um.chg"
	check "changed: only the edited option" sh -c "[ \"\$(cat '$W/um.chg')\" = 'mib.LAN_IP_ADDR=192.168.0.2' ]"
}

# ------------------------------------------- stock SPI firewall switches

t_spi() {
	echo "spi (stock SPI firewall MIB pinning)"
	local f="$TOP/package/rtk-vendor/files/usr/libexec/rtk/spi-firewall" D="$W/spi"
	mkdir -p "$D"
	{
		sed -n '/^pin()/,/^}/p' "$f"
		sed -n '/^spi_apply()/,/^}/p' "$f"
	} > "$D/lib.sh"
	# spi MIB-STATE V4-MODE V6-MODE [readonly] -> the flash writes
	spi() {
		printf '%s\n' $1 > "$D/mib"; : > "$D/writes"
		"$BB" sh -c "
			logger() { :; }
			mib_get() { sed -n \"s/^\$1=//p\" '$D/mib'; }
			mib_set() { [ -z '$4' ] || return 1; echo \"\$1=\$2\" >> '$D/writes'; }
			. '$D/lib.sh'; changed=0
			spi_apply '$2' ''; spi_apply '$3' V6_" >/dev/null 2>&1
		tr '\n' ' ' < "$D/writes"
	}
	local factory='IPF_IN_ACTION=0 IPF_OUT_ACTION=1 V6_IPF_IN_ACTION=0 V6_IPF_OUT_ACTION=1'
	local open='IPF_IN_ACTION=1 IPF_OUT_ACTION=1 V6_IPF_IN_ACTION=1 V6_IPF_OUT_ACTION=1'
	local trap='IPF_IN_ACTION=0 IPF_OUT_ACTION=0 V6_IPF_IN_ACTION=0 V6_IPF_OUT_ACTION=0'
	check "factory -> off/off: only the two incoming switches written" sh -c \
		"[ \"$(spi "$factory" off off)\" = 'IPF_IN_ACTION=1 V6_IPF_IN_ACTION=1 ' ]"
	check "already off: nothing written" sh -c "[ -z \"$(spi "$open" off off)\" ]"
	check "outgoing lock-out -> on/on: outgoing allowed again, incoming kept" sh -c \
		"[ \"$(spi "$trap" on on)\" = 'IPF_OUT_ACTION=1 V6_IPF_OUT_ACTION=1 ' ]"
	check "keep: nothing written, even from the lock-out state" sh -c "[ -z \"$(spi "$trap" keep keep)\" ]"
	check "per family: off for IPv4, stock default for IPv6" sh -c \
		"[ \"$(spi "$open" off on)\" = 'V6_IPF_IN_ACTION=0 ' ]"
	check "unknown mode: nothing written" sh -c "[ -z \"$(spi "$factory" disabled '')\" ]"
	check "flash set failing: no partial state recorded" sh -c "[ -z \"$(spi "$factory" off off readonly)\" ]"
}

# ---------------------------------------------------- live apply layer

t_apply() {
	echo "apply (stock config changes -> rtk-apply, like the boa forms)"
	local D="$W/apply"
	mkdir -p "$D"
	# stubs: rtk records its arguments, mib_get reads a file, uci answers
	# nijika.vendor.live_apply, logger records what would be logged
	{
		echo "rtk() { echo \"\$*\" >> '$D/calls'; }"
		echo "logger() { [ \"\$1\" = -t ] && shift 2; echo \"\$*\" >> '$D/log'; }"
		echo "mib_get() { sed -n \"s/^\$1=//p\" '$D/mib'; }"
		echo "uci() { cat '$D/live' 2>/dev/null; }"
		echo ". '$LIB/apply.sh'"
	} > "$D/env.sh"
	areas() { printf '%s\n' "$@" | "$BB" sh -c ". '$D/env.sh'; apply_areas"; }
	check "keys -> areas: WAN records first, then fixed order, no repeats" sh -c "[ \"$(areas WLAN_MBSSIB_TBL.0.ssid IPF_IN_ACTION ATM_VC_TBL.0.vid ATM_VC_TBL.0.MTU LAN_IP_ADDR SSID ATM_VC_TBL.2.vid)\" = 'wan:0 wan:2 firewall lan wlan' ]"
	check "GPON and unknown keys: loid, ploam, reboot" sh -c "[ \"$(areas GPON_SN LOID_PASSWD GPON_PLOAM_PASSWD LOID)\" = 'loid ploam reboot' ]"
	check "wlan0 keys without the WLAN_ prefix are WiFi" sh -c "[ \"$(areas CHANNEL AUTO_CHANNEL HIDDEN_SSID SSID WLAN_RFPOWER_SCALE DTIM_PERIOD)\" = 'wlan' ]"
	check "band steering and EasyMesh keys restart WiFi" sh -c "[ \"$(areas WIFI_STA_CONTROL MAP_DEVICE_NAME)\" = 'wlan' ]"
	check "LAN page keys: port, LAN, snooping, LAN<->WiFi blocking" sh -c "[ \"$(areas SW_PORT_TBL.3.Enable MP_MODE WLAN_BLOCK_ETH2WIR LAN_IP_ADDR)\" = 'port:3 lan snooping wlanblock' ]"
	check "device type / OLT mode: one OMCI restart, after the PLOAM" sh -c "[ \"$(areas OMCI_OLT_MODE GPON_PLOAM_PASSWD DEVICE_TYPE)\" = 'ploam omci' ]"
	check "SPI keys are firewall (IPv4, IPv6, session, MAC, DMZ, rules)" sh -c "[ \"$(areas V6_IPF_OUT_ACTION V6_SESSION_FW_ENABLE MACF_IN_ACTION DMZ_IP IP_PORT_FILTER_TBL.1.dip)\" = 'firewall' ]"
	run() { # live_apply code -> rtk calls and the return code, one line
		: > "$D/calls"; : > "$D/log"; printf '%s' "$1" > "$D/live"
		printf '%s\n' 'LOID=TM12345' 'LOID_PASSWD=' 'GPON_PLOAM_PASSWD=s3cret' > "$D/mib"
		"$BB" sh -c ". '$D/env.sh'; $2; echo \"rc=\$?\" >> '$D/calls'"
		tr '\n' ';' < "$D/calls"
	}
	check "port forwarding keys: portfw, after the firewall (DMZ)" sh -c "[ \"$(areas PORT_FW_TBL.0.IP DMZ_IP PORT_FW_ENABLE)\" = 'firewall portfw' ]"
	check "WAN mode change: wan-mode before the record comes up" sh -c "[ \"$(areas ATM_VC_TBL.1.ChannelMode ATM_VC_TBL.1.vid ATM_VC_TBL.0.MTU)\" = 'wanmode:1 wan:0 wan:1' ]"
	check "wan-mode, then wan-up, nothing before the write" sh -c "[ \"$(run 1 "apply_before wanmode:1 wan:1; echo WRITE >> '$D/calls'; apply_after wanmode:1 wan:1")\" = '/bin/rtk-apply wan-down 1;WRITE;/bin/rtk-apply wan-mode 1;/bin/rtk-apply wan-up 1;rc=0;' ]"
	check "WAN edit: wan-down before the write, wan-up after" sh -c "[ \"$(run 1 "apply_before wan:0 firewall; echo WRITE >> '$D/calls'; apply_after wan:0 firewall")\" = '/bin/rtk-apply wan-down 0;WRITE;/bin/rtk-apply wan-up 0;/bin/rtk-apply firewall;rc=0;' ]"
	check "GPON as formgponConf: omcicli LOID, PLOAM, then OMCI restart" sh -c "[ \"$(run 1 'apply_after loid ploam')\" = '/bin/omcicli set loid TM12345;/bin/rtk-apply gpon-ploam s3cret;/bin/rtk-apply gpon-omci;rc=0;' ]"
	check "the PLOAM password is never logged" sh -c "! grep -q s3cret '$D/log'"
	check "omci: restartOMCIsettings only" sh -c "[ \"$(run 1 'apply_after omci')\" = '/bin/rtk-apply gpon-omci;rc=0;' ]"
	check "reboot area: the live parts run, return 1" sh -c "[ \"$(run 1 'apply_after wlan reboot')\" = '/bin/rtk-apply wlan;rc=1;' ]"
	check "live_apply=0: nothing runs, reboot needed" sh -c "[ \"$(run 0 'apply_before wan:0; apply_after wan:0 wlan')\" = 'rc=1;' ]"
	check "live_apply=0, nothing written: no reboot" sh -c "[ \"$(run 0 'apply_after')\" = 'rc=0;' ]"
}

# ------------------------------------- EasyMesh role pinned (easymesh-pin)

# The D-Link/TM role "auto" turns the unit into a mesh node when the WPS
# button is pressed without fibre (LAN DHCP client, no DHCP server): the
# gateway keeps controller/disabled, an earlier agent's DHCP client mode is
# undone.
t_easymesh() {
	echo "easymesh (role pinned: the gateway never turns into a mesh node)"
	local D="$W/em"
	mkdir -p "$D"
	{
		echo "config_load() { :; }"
		echo "config_get() { local v; v=\$(cat '$D/want'); [ -n \"\$v\" ] || v=\$4; eval \"\$1=\\\$v\"; }"
		echo "vendor_up() { :; }"
		echo "mib_get() { sed -n \"s/^\$1=//p\" '$D/mib'; }"
		echo "mib_set() { echo \"set \$1 \$2\" >> '$D/calls'; }"
		echo "rtk_apply() { echo \"rtk-apply \$*\" >> '$D/calls'; }"
		echo "apply_after() { echo \"apply \$*\" >> '$D/calls'; }"
		echo "logger() { :; }"
	} > "$D/env.sh"
	sed '/^\. /d' "$TOP/package/rtk-vendor/files/usr/libexec/rtk/easymesh-pin" > "$D/pin"
	pin() { # setting MAP_CONTROLLER DHCP_MODE [boot] -> calls, one line
		printf '%s' "$1" > "$D/want"
		printf 'MAP_CONTROLLER=%s\nDHCP_MODE=%s\n' "$2" "$3" > "$D/mib"
		: > "$D/calls"
		"$BB" sh -c ". '$D/env.sh'; set -- $4; . '$D/pin'"
		tr '\n' ';' < "$D/calls"
	}
	check "boot, stock auto: controller before the WiFi starts" \
		sh -c "[ \"$(pin controller 3 2 boot)\" = 'rtk-apply easymesh controller auto 3 norestart;' ]"
	check "boot after a WPS press without fibre (agent): controller, DHCP server again" \
		sh -c "[ \"$(pin controller 2 3 boot)\" = 'rtk-apply easymesh controller agent 3 norestart;set DHCP_MODE 2;' ]"
	check "runtime: WiFi restart and the LAN applied" \
		sh -c "[ \"$(pin '' 2 3)\" = 'rtk-apply easymesh controller agent 3;set DHCP_MODE 2;apply lan;' ]"
	check "disabled is pinned too, a LAN DHCP client of its own stays" \
		sh -c "[ \"$(pin disabled 1 3 boot)\" = 'rtk-apply easymesh disabled controller 3 norestart;' ]"
	check "nothing to do when the role matches; auto is left to the stock stack" \
		sh -c "[ -z \"$(pin controller 1 2 boot)$(pin auto 2 3 boot)\" ]"
}

# ------------------------------------------- native helpers (rtk-apply)

t_helpers() {
	echo "helpers (rtk-apply against the stock libraries)"
	local bin="$TOP/build/helpers/rtk-apply" rtk="$TOP/build/stage/rtk"
	[ -x "$bin" ] || { skp "rtk-apply" "not built (./build.sh assemble)"; return; }
	readelf -d "$bin" | grep NEEDED > "$W/needed"
	check "DT_NEEDED: librtk.so and libmib.so.0 by name, no build-host paths" sh -c "
		grep -qF '[librtk.so]' '$W/needed' && grep -qF '[libmib.so.0]' '$W/needed' && ! grep -q / '$W/needed'"
	check "symbol versions within the stock glibc 2.30" sh -c "
		[ -z \"\$(readelf -V '$bin' | grep -oE 'GLIBC_2\.[0-9]+' | awk -F. '\$2 > 30')\" ]"
	if command -v qemu-aarch64-static >/dev/null && [ -f "$rtk/lib/libmib.so" ]; then
		check "loads with every symbol bound (qemu, stock /lib)" sh -c "
			cp '$bin' '$rtk/bin/rtk-apply' &&
			LD_BIND_NOW=1 qemu-aarch64-static -L '$rtk' '$rtk/bin/rtk-apply' 2>&1 | grep -q '^usage: rtk-apply'"
	else
		skp "qemu load test" "no qemu-aarch64-static or stock tree"
	fi
	logrelay_tests
	local st="$TOP/build/stage"
	if [ -d "$st/etc/rc.d" ]; then
		check "reboot releases the WAN: K10rtk-vendor -> shutdown()" sh -c "
			[ -L '$st/etc/rc.d/K10rtk-vendor' ] && grep -q '^shutdown()' '$st/etc/init.d/rtk-vendor' &&
			[ -x '$st/usr/libexec/rtk/vendor-shutdown' ]"
		check "uci mirror commits configd's delayed writes before it reads flash back" sh -c "
			awk '/push < /{p=NR} /mib commit cs now/{c=NR} /^\tdump > /{d=NR} END{exit !(p && c > p && d > c)}' '$st/usr/libexec/rtk/uci-mirror'"
		check "LuCI: stock pages and the PON / Nijika menus" "$PY" -I -c "
import json, sys
d = json.load(open(sys.argv[1]))
views = {v.get('action', {}).get('path') for v in d.values()}
assert {'nijika/wan', 'nijika/lan', 'nijika/wlan', 'nijika/portfw', 'nijika/dmz', 'nijika/voip', 'nijika/gpon'} <= views, views
assert 'nijika/omci' not in views
assert d['admin/nijika/identity']['depends']['uci'] == {'nijika': {'ui': {'developer': '1'}}}
order = sorted((v['order'], k) for k, v in d.items() if k.startswith('admin/nijika/'))
assert [k for _, k in order] == ['admin/nijika/auth', 'admin/nijika/identity', 'admin/nijika/status', 'admin/nijika/provision'], order
assert {'admin/nijikawrt/settings', 'admin/nijikawrt/firmware', 'admin/nijikawrt/mib'} <= set(d)
" "$st/usr/share/luci/menu.d/luci-app-nijika.json"
		check "stock TR-069 client / SNMP agent behind their wrappers, real ones kept" sh -c "
			grep -q 'NijikaWrt wrapper' '$st/rtk/bin/cwmpClient' && grep -q 'NijikaWrt wrapper' '$st/rtk/bin/snmpd' &&
			[ -x '$st/rtk/lib/nijika/cwmpClient' ] && [ -x '$st/rtk/lib/nijika/snmpd' ] &&
			grep -q 'stock-services boot' '$st/usr/libexec/rtk/vendor-boot' &&
			grep -q \"option tr069 '0'\" '$st/etc/config/nijika'"
		check "Overview: System, PON / ONT, WAN, memory, storage (no empty OpenWrt cards)" sh -c "
			[ \"\$(ls '$st/www/luci-static/resources/view/status/include' | tr '\n' ' ')\" = '10_system.js 15_nijika.js 17_nijika_wan.js 20_memory.js 25_storage.js ' ]"
		check "EasyMesh role pinned before the stock WiFi starts" sh -c "
			grep -q 'easymesh-pin boot' '$st/usr/libexec/rtk/vendor-boot' && [ -x '$st/usr/libexec/rtk/easymesh-pin' ] &&
			grep -q \"option easymesh 'controller'\" '$st/etc/config/nijika'"
		check "stock hostapd behind its wrapper (BSS colouring), real one kept" sh -c "
			grep -q 'NijikaWrt wrapper' '$st/rtk/bin/hostapd' && [ -x '$st/rtk/lib/nijika/hostapd' ] &&
			grep -q \"option bss_color_wlan0 '1'\" '$st/etc/config/nijika'"
		check "WiFi defaults hook runs before the uci mirror, once" sh -c "
			[ -x '$st/usr/libexec/rtk/post-boot.d/35-wifi-defaults' ] &&
			grep -q 'nijika.vendor.wifi_defaults' '$st/usr/libexec/rtk/post-boot.d/35-wifi-defaults'"
		check "rpcd: WPS and EasyMesh methods are granted" sh -c "
			grep -q '\"easymesh_set\"' '$st/usr/share/rpcd/acl.d/luci-app-nijika.json' &&
			grep -q '\"wps\"' '$st/usr/share/rpcd/acl.d/luci-app-nijika.json' &&
			grep -q 'easymesh_pair) m_easymesh_pair' '$st/usr/libexec/rpcd/nijika'"
		if [ -d "$st/usr/lib/nijika/kmod/5.10.70" ]; then
			check "stage: the WireGuard modules in /lib/modules/5.10.70 (ubox insmod needs the folder), no /etc/modules.d" sh -c "
				[ -L '$st/lib/modules/5.10.70' ] && [ -f '$st/lib/modules/5.10.70/wireguard.ko' ] &&
				[ \"\$(readlink '$st/lib/modules/5.10.70')\" = ../../usr/lib/nijika/kmod/5.10.70 ] && [ ! -e '$st/etc/modules.d' ]"
		fi
	fi
}

# logrelay (stock syslog -> logd): the filter, built for the host
logrelay_tests() {
	local libc="$TOP/build/stage/rtk/lib/libc-2.30.so"
	if [ -f "$libc" ]; then
		check "stock libc: syslog to /var/slg, no /dev/log left" sh -c "
			[ \$(grep -c -a -o '/var/slg' '$libc') -eq 1 ] && ! grep -q -a '/dev/log' '$libc'"
	else
		skp "stock libc patch" "no staged rootfs"
	fi
	if ! command -v gcc >/dev/null || [ -z "$PY" ]; then
		skp "logrelay filter" "no gcc or python3"
		return
	fi
	gcc -O2 -Wall -Werror -o "$W/logrelay" "$TOP/package/rtk-vendor/src/logrelay.c" 2>"$W/gcc.err" ||
		{ bad "logrelay compiles" "$(cat "$W/gcc.err")"; return; }
	mkdir -p "$W/lr"
	check "logrelay: notice and up pass (stock slogd -l 5), info/debug dropped" sh -c "
		[ \"\$('$PY' -I '$TOP/tests/logrelay_test.py' '$W/logrelay' '$W/lr' | tr '\\n' ' ')\" = 'user.notice user.err local0.notice no header ' ]"
}

# ------------------------------------- scripts run by the stock busybox

# fwu.sh (factory installer, run by the stock firmware) and the /rtk/bin
# wrappers/placeholders run under the stock busybox 1.22 ash, which lacks
# things the host shell and OpenWrt's busybox 1.37 have (no `command`
# builtin: `command -v` fails there, silently).
t_stockshell() {
	echo "stockshell (scripts the stock busybox 1.22 ash runs, via qemu)"
	local R="$TOP/build/stage/rtk" f errs=""
	if ! command -v qemu-aarch64-static >/dev/null || [ ! -x "$R/bin/busybox" ]; then
		skp "stock busybox" "no qemu-aarch64-static or stock tree (./build.sh assemble)"
		return
	fi
	sbb() { qemu-aarch64-static -L "$R" "$R/bin/busybox" "$@"; }
	for f in "$TOP/firmware/fwu.sh" "$TOP"/package/rtk-vendor/files/rtk/bin/* \
		"$TOP/package/rtk-vendor/files/rtk/etc/nijika/rcS"; do
		sbb sh -n "$f" 2>/dev/null || errs="$errs ${f#$TOP/}"
	done
	[ -z "$errs" ] && ok "every script parses under the stock ash" || bad "stock ash syntax" "$errs"
	check "no 'command -v' (busybox 1.22 has no 'command' builtin)" sh -c "
		! grep -nE '(^|[^A-Za-z_])command -[vV]' '$TOP/firmware/fwu.sh' $TOP/package/rtk-vendor/files/rtk/bin/*"
	# fwu.sh phy_ids with a diag that answers like the A1 switch
	{
		echo 'diag() { case "$5/$9" in [0-3]/2) v=001C ;; [0-3]/3) v=CAC4 ;; *) v=FFFF ;; esac'
		echo '	echo "Port $5 Page 0 Register $9: 0x$v"; }'
		sed -n '/^phy_ids() {/,/^}/p' "$TOP/firmware/fwu.sh"
		echo 'echo "[$(phy_ids)]"'
	} > "$W/phy.sh"
	check "hostapd wrapper's colour arithmetic works in the stock ash (hex)" sh -c "
		[ \"\$(qemu-aarch64-static -L '$R' '$R/bin/busybox' sh -c 'last=2f; echo \$(( 0x\$last % 63 + 1 ))')\" = 48 ]"
	check "fwu.sh reads the A1 PHY IDs under the stock ash" sh -c "
		[ \"\$(qemu-aarch64-static -L '$R' '$R/bin/busybox' sh '$W/phy.sh')\" = '[001ccac4 001ccac4 001ccac4 001ccac4 ffffffff ffffffff ffffffff]' ]"
}

# ------------------------------------------------ preinit boot-env hook

t_bootenv() {
	echo "bootenv (U-Boot A/B bookkeeping)"
	local D="$W/be"
	mkdir -p "$D"
	cat > "$D/nv" <<EOF
#!/bin/sh
case "\$1" in
	getenv) grep "^\$2=" "$D/env" ;;
	setenv) grep -v "^\$2=" "$D/env" > "$D/env.n"; echo "\$2=\$3" >> "$D/env.n"; mv "$D/env.n" "$D/env"; echo "\$2=\$3" >> "$D/writes" ;;
esac
EOF
	chmod +x "$D/nv"
	sed -e "s|/usr/libexec/rtk/glibc /rtk/bin/nv|$D/nv|" -e "s|-x /rtk/bin/nv|-x $D/nv|" \
		-e "s|/proc/cmdline|$D/cmdline|" -e "s|mkdir -p /var/run|:|" \
		"$TOP/package/nijika-base/files/lib/preinit/03_nijika_bootenv" > "$D/hook"
	be() { # cmdline env... -> writes
		echo "$1" > "$D/cmdline"; shift
		printf '%s\n' "$@" > "$D/env"; : > "$D/writes"
		"$BB" sh -c "boot_hook_add() { :; }; . '$D/hook'; nijika_bootenv" >/dev/null 2>&1
		tr '\n' ' ' < "$D/writes"
	}
	check "trial of bank 0 not saved by U-Boot: tryactive=2, active=0" sh -c \
		"[ \"$(be 'root=31:8 x' sw_active=1 sw_commit=1 sw_tryactive=0)\" = 'sw_tryactive=2 sw_active=0 ' ]"
	check "committed bank 0: nothing written" sh -c \
		"[ -z \"$(be 'root=31:8 x' sw_active=0 sw_commit=0 sw_tryactive=2)\" ]"
	check "manual boot while another trial is pending: only active fixed" sh -c \
		"[ \"$(be 'root=31:8 x' sw_active=1 sw_commit=1 sw_tryactive=1)\" = 'sw_active=0 ' ]"
	check "no root= on the command line: nothing written" sh -c \
		"[ -z \"$(be 'console=ttyS0' sw_active=1 sw_commit=1 sw_tryactive=0)\" ]"
}

# ------------------------------------------------- factory installer dry run

t_fwu() {
	echo "fwu (factory installer, tools/fwu-dryrun.sh)"
	local img s want got
	img=$(ls "$TOP"/bin/*-factory.bin 2>/dev/null | head -n 1)
	[ -n "$img" ] || { skp "fwu dry run" "no factory image in bin/, run ./build.sh"; return; }
	# scenario:expected exit code
	for s in 1:0 2:0 3:1 4:1 5:1 6:1 7:0 8:1 9:1 10:1 11:0; do
		want=${s#*:}
		got=$("$TOP/tools/fwu-dryrun.sh" "$img" "${s%%:*}" 2>&1 | sed -n 's/^ exit code \([0-9]*\),.*/\1/p')
		title=$("$TOP/tools/fwu-dryrun.sh" "$img" "${s%%:*}" 2>&1 | sed -n "s/^ \(${s%%:*}\. .*\)/\1/p")
		[ "$got" = "$want" ] && ok "$title -> exit $got" || bad "$title" "exit '$got', expected $want"
	done
}

# ------------------------------------------------------------------ banner

t_banner() {
	echo "banner"
	local out pv="$TOP/tools/banner-preview.sh"
	out=$(REV=r7 NODATA=1 ANIMATE=never COLOR=none sh "$pv" 2>&1)
	check "layout: centred logo, 'ft. <model>' under the tagline, links" sh -c '
		printf "%s\n" "$1" | grep -qx "        |    |  |__|__|__|  |--.---.-.|  |  |  |.----.|  |_" &&
		printf "%s\n" "$1" | grep -qx "                                            ft. DPN-FX3060V (A1)" &&
		printf "%s\n" "$1" | grep -qx " Homepage    : https://openpon.org/" &&
		printf "%s\n" "$1" | grep -qx " GitHub      : https://github.com/PururinCollective" &&
		printf "%s\n" "$1" | grep -q "PON status pending  |  RX n/a  |  TX n/a"' _ "$out"
	out=$(STATE=O5 RX=-16.27 TX=2.73 ANIMATE=never COLOR=truecolor sh "$pv" 2>&1)
	check "live light: both rules red" sh -c '
		[ $(printf "%s\n" "$1" | grep -E "TX 1310|RX 1490" | grep -c "38;2;210;48;48m") -eq 2 ]' _ "$out"
	out=$(STATE=O1.1 LOS=1 RX=-inf TX=-inf ANIMATE=never COLOR=truecolor sh "$pv" 2>&1)
	check "no fibre: rules grey, LOS and no light" sh -c '
		[ $(printf "%s\n" "$1" | grep -E "TX 1310|RX 1490" | grep -c "38;2;210;48;48m") -eq 0 ] &&
		printf "%s" "$1" | grep -q "no signal (LOS)" && printf "%s" "$1" | grep -q "no light"' _ "$out"
	out=$(STATE=O5 RX=-16.27 TX=2.73 ANIMATE=always COLOR=256 SLEEP="printf @" sh "$pv" 2>&1)
	check "animation: 36 frames, cursor shown again at the end" sh -c '
		[ $(printf "%s" "$1" | tr -cd @ | wc -c) -eq 35 ] && printf "%s" "$1" | grep -q "?25h"' _ "$out"
}

# ------------------------------------------------------------------- theme

t_theme() {
	echo "theme"
	local P="$TOP/package/luci-theme-perfect" D="$W/theme"
	mkdir -p "$D"
	# uci-defaults against a key=value store: start state -> final mediaurlbase
	defaults() {
		printf '%s\n' "$@" > "$D/uci"
		"$BB" sh -c "
			uci() {
				[ \"\$1\" = -q ] && shift
				case \"\$1\" in
					get) grep \"^\$2=\" '$D/uci' | cut -d= -f2- | grep . ;;
					set) echo \"\$2\" >> '$D/uci' ;;
					commit) ;;
				esac
			}
			. '$P/root/etc/uci-defaults/30_luci-theme-perfect'" >/dev/null 2>&1
		grep '^luci.main.mediaurlbase=' "$D/uci" | tail -n 1 | cut -d= -f2-
	}
	check "first boot: Perfect registered and made the default" sh -c '
		[ "$1" = /luci-static/perfect ]' _ \
		"$(defaults luci.main.mediaurlbase=/luci-static/bootstrap luci.themes.Bootstrap=/luci-static/bootstrap)"
	check "theme picked later survives the next upgrade" sh -c '
		[ "$1" = /luci-static/bootstrap ]' _ \
		"$(defaults luci.main.mediaurlbase=/luci-static/bootstrap luci.themes.Perfect=/luci-static/perfect)"
	check "files referenced by the templates and perfect.css exist" sh -c '
		cd "$1/htdocs/luci-static/perfect" || exit 1
		for f in $(sed -n "s|.*{{ media }}/\([^\"?]*\).*|\1|p" "$1"/root/usr/share/ucode/luci/template/themes/perfect/*.ut) \
		         $(grep -o "url(\"[^\"]*\")" perfect.css | grep -v "url(\"data:" | sed "s|^url(\"||; s|\")\$||"); do
			[ -f "$f" ] || { echo "missing $f"; exit 1; }
		done' _ "$P"
	if [ -d "$TOP/build/stage/www/luci-static/bootstrap" ]; then
		check "Bootstrap files the theme loads are in the built image" sh -c '
			for f in luci-static/bootstrap/cascade.css luci-static/bootstrap/mobile.css luci-static/resources/menu-bootstrap.js; do
				[ -f "$1/$f" ] || { echo "missing /www/$f"; exit 1; }
			done' _ "$TOP/build/stage/www"
	else
		skp "Bootstrap files in the built image" "no build/stage"
	fi
}

# ------------------------------------------------------------------- ddns

t_ddns() {
	echo "ddns (address check, providers, secrets off the command line)"
	[ -n "$PY" ] || { skp "ddns" "no python3 (fake jsonfilter)"; return; }
	local D="$W/ddns" st hp
	mkdir -p "$D/bin" "$D/state"
	# fakes: curl answers from $D/resp (glob|code|body) and logs its
	# arguments and the config it got on stdin; ip, logger, jsonfilter
	cat > "$D/bin/curl" <<CURL
#!/bin/sh
cfg=
case " \$* " in *" -K - "*) cfg=\$(cat) ;; esac
url=\$(printf '%s\n' "\$cfg" | sed -n 's/^url = "\(.*\)"\$/\1/p' | tail -n 1)
[ -n "\$url" ] || for a in "\$@"; do url=\$a; done
{ printf 'ARGS %s\n' "\$*"; printf '%s\n' "\$cfg" | sed 's/^/CFG /'; printf 'URL %s\n' "\$url"; } >> "$D/curl.log"
code=000 body=
while IFS='|' read -r pat c b; do
	case "\$url" in \$pat) code=\$c body=\$b; break ;; esac
done < "$D/resp"
w=0; case " \$* " in *" -w "*) w=1 ;; esac
if [ "\$code" = 000 ]; then echo 'curl: (6) Could not resolve host: mock' >&2; [ \$w = 1 ] && printf '\n000'; exit 6; fi
case " \$* " in *" -fsS "*) [ "\$code" -ge 400 ] && exit 22 ;; esac
printf '%s' "\$body"
[ \$w = 1 ] && printf '\n%s' "\$code"
exit 0
CURL
	cat > "$D/bin/ip" <<IP
#!/bin/sh
case "\$*" in
	"-4 route show default") cat "$D/route" 2>/dev/null ;;
	"-4 -o addr show dev "*) cat "$D/addr.\$6" 2>/dev/null ;;
esac
IP
	printf '#!/bin/sh\necho "$*" >> %s/log\n' "$D" > "$D/bin/logger"
	cat > "$D/bin/jsonfilter" <<'JF'
#!/usr/bin/env python3
import json, re, sys
a = sys.argv[1:]
s = a[a.index('-s') + 1]
e = a[a.index('-e') + 1]
try:
    v = json.loads(s)
    for key, idx in re.findall(r'\.(\w+)|\[(\d+)\]', e[1:]):
        v = v[int(idx)] if idx else v[key]
except Exception:
    sys.exit(1)
print('true' if v is True else 'false' if v is False else v)
JF
	chmod +x "$D/bin/curl" "$D/bin/ip" "$D/bin/logger" "$D/bin/jsonfilter"
	# config_* over a shell file of CFG_<section>_<option>=... lines
	cat > "$D/functions.sh" <<FN
config_load() { . "$D/cfg"; }
config_get() { eval "\$1=\\\${CFG_\${2}_\${3}-\\\$4}"; }
config_get_bool() { local _v; config_get _v "\$2" "\$3" "\$4"; case "\$_v" in 1|on|true|yes|enabled) _v=1 ;; *) _v=0 ;; esac; eval "\$1=\\\$_v"; }
config_foreach() { local _s _l; eval "_l=\\\$CFG_SECTIONS_\$2"; for _s in \$_l; do "\$1" "\$_s"; done; }
# busybox sh would run its own ip and logger applets
ip() { "$D/bin/ip" "\$@"; }
logger() { "$D/bin/logger" "\$@"; }
FN
	sed -e "s|^\. /lib/functions.sh|. $D/functions.sh|" -e "s|^STATE=.*|STATE=$D/state|" \
		"$TOP/package/nijika/files/usr/libexec/nijika/ddns" > "$D/ddns"
	ddns() { PATH="$D/bin:$PATH" "$BB" sh "$D/ddns" "$@"; }
	fresh() { rm -f "$D"/state/* "$D/curl.log" "$D/log"; }
	cfg() { printf '%s\n' "$@" > "$D/cfg"; }
	resp() { printf '%s\n' "$@" > "$D/resp"; }

	# address classes
	sed -n -e '/^IP4_RE=/p' -e '/^ip4_num() {/,/^}/p' -e '/^ip4_kind() {/,/^}/p' "$D/ddns" > "$D/kind.sh"
	st=$(for a in 100.64.0.1 100.127.255.254 100.128.0.1 10.1.2.3 172.31.0.1 172.32.0.1 192.168.1.1 \
		192.0.2.5 192.0.0.2 198.18.0.1 198.51.100.23 203.0.113.9 224.0.0.1 255.255.255.255 0.1.2.3 \
		127.0.0.1 169.254.1.1 8.8.8.8 1.2.3.4; do
		"$BB" sh -c '. "$1"; ip4_kind "$2"' sh "$D/kind.sh" "$a"; done | tr '\n' ' ')
	check "address classes: CGNAT, private, reserved (TEST-NETs, DS-Lite 192.0.0.2, multicast), public" \
		[ "$st" = 'cgnat cgnat public private private public private reserved reserved reserved reserved reserved reserved reserved reserved reserved reserved public public ' ]

	# public WAN: its own address, nothing asked
	echo 'default via 5.6.7.1 dev ppp0 proto static' > "$D/route"
	echo '5: ppp0    inet 5.6.7.8 peer 5.6.7.1/32 scope global ppp0' > "$D/addr.ppp0"
	resp; cfg; fresh
	st=$(ddns ip)
	check "public WAN address (ppp0): published as is, no lookup" sh -c "
		echo '$st' | grep -qx kind=public && echo '$st' | grep -qx ip=5.6.7.8 &&
		echo '$st' | grep -qx source=wan && echo '$st' | grep -qx wan=ppp0 && [ ! -s '$D/curl.log' ]"

	# CGNAT: the address the internet sees, the first public answer counts
	echo '5: ppp0    inet 100.70.12.34 peer 100.64.0.1/32 scope global ppp0' > "$D/addr.ppp0"
	resp 'http://ip1.dynupdate.no-ip.com/|200|10.0.0.9' 'https://api.ipify.org/|200|1.2.3.4'
	fresh
	st=$(ddns ip)
	check "CGNAT (100.64.0.0/10): looked up, a private answer skipped, the next used" sh -c "
		echo '$st' | grep -qx kind=cgnat && echo '$st' | grep -qx ip=1.2.3.4 &&
		echo '$st' | grep -qx wan_ip=100.70.12.34 && echo '$st' | grep -qx source=https://api.ipify.org/"
	check "CGNAT: warning in the log, recommends IPv6" sh -c "grep -q 'carrier-grade NAT' '$D/log' && grep -q IPv6 '$D/log'"
	rm -f "$D/state/status"
	echo 'default via 192.168.1.1 dev nas0_1' > "$D/route"
	echo '7: nas0_1    inet 192.168.1.20/24 brd 192.168.1.255 scope global nas0_1' > "$D/addr.nas0_1"
	st=$(ddns ip)
	check "private WAN address (a router in front): looked up, warned" sh -c "
		echo '$st' | grep -qx kind=private && echo '$st' | grep -qx ip=1.2.3.4 && grep -q 'not a public address' '$D/log'"
	echo 'default via 100.64.0.1 dev ppp0 proto static' > "$D/route"
	resp; rm -f "$D/state/status" "$D/state/lookup"
	st=$(ddns ip)
	check "no lookup service answers: nothing to publish, lookup_error" sh -c "
		echo '$st' | grep -qx ip= && echo '$st' | grep -qx lookup_error=1"

	# DynDNS v2 (No-IP): the credentials go in curl's config on stdin
	resp 'https://api.ipify.org/|200|1.2.3.4' \
		'https://dynupdate.no-ip.com/nic/update?hostname=home.example.net&myip=1.2.3.4|200|good 1.2.3.4'
	cfg 'CFG_SECTIONS_ddns_host=h1' 'CFG_h1_provider=noip' 'CFG_h1_hostname=home.example.net' \
		'CFG_h1_username=user1' "CFG_h1_password='s3\"cr\\et'"
	fresh; ddns update
	check "No-IP: updated (good), address kept" sh -c "cat '$D'/state/h.* | grep -qx result=good && cat '$D'/state/h.* | grep -qx ip=1.2.3.4"
	check "No-IP: user name and password only in curl's stdin config, quoted" sh -c "
		grep -qF 'CFG user = \"user1:s3\\\"cr\\\\et\"' '$D/curl.log' && ! grep '^ARGS' '$D/curl.log' | grep -q -e user1 -e s3"
	ddns update
	check "unchanged address: not sent again, the lookup reused (check_interval)" sh -c "
		[ \$(grep -c '^URL https://dynupdate' '$D/curl.log') -eq 1 ] && [ \$(grep -c '^URL https://api.ipify' '$D/curl.log') -eq 1 ]"
	ddns update -f
	check "update -f: sent again, the address asked again" sh -c "
		[ \$(grep -c '^URL https://dynupdate' '$D/curl.log') -eq 2 ] && [ \$(grep -c '^URL https://api.ipify' '$D/curl.log') -eq 2 ]"

	# a permanent error stops the entry until its settings change
	sed -i 's/|good 1.2.3.4$/|badauth/' "$D/resp"
	echo "CFG_h1_password=other" >> "$D/cfg"
	fresh; ddns update; ddns update
	check "badauth: failed, not retried by itself" sh -c "
		cat '$D'/state/h.* | grep -qx result=failed && [ \$(grep -c '^URL https://dynupdate' '$D/curl.log') -eq 1 ] && grep -q badauth '$D/log'"
	ddns update -f
	check "badauth: update -f tries again" sh -c "[ \$(grep -c '^URL https://dynupdate' '$D/curl.log') -eq 2 ]"

	# a temporary error waits for its retry time
	resp 'https://api.ipify.org/|200|1.2.3.4'
	cfg 'CFG_SECTIONS_ddns_host=h1' 'CFG_h1_provider=dynu' 'CFG_h1_hostname=a.example.net' 'CFG_h1_username=u' 'CFG_h1_password=p'
	fresh; ddns update; ddns update
	check "no connection: error with a retry time, not repeated every minute" sh -c "
		cat '$D'/state/h.* | grep -qx result=error && cat '$D'/state/h.* | grep -q '^next=[0-9]' &&
		[ \$(grep -c '^URL https://api.dynu.com' '$D/curl.log') -eq 1 ]"

	# freedns.afraid.org: the pasted update URL, the address added
	resp 'https://api.ipify.org/|200|1.2.3.4' \
		'https://freedns.afraid.org/dynamic/update.php?AbC123xyz=&address=1.2.3.4|200|ERROR: Address 1.2.3.4 has not changed.'
	cfg 'CFG_SECTIONS_ddns_host=h1' 'CFG_h1_provider=afraid' "CFG_h1_url='https://freedns.afraid.org/dynamic/update.php?AbC123xyz=&foo=1'"
	fresh; ddns update
	check "freedns.afraid.org URL: its token, the address added; 'has not changed' = up to date" sh -c "
		cat '$D'/state/h.* | grep -qx result=nochg && ! grep '^ARGS' '$D/curl.log' | grep -q AbC123"
	cfg 'CFG_SECTIONS_ddns_host=h1' 'CFG_h1_provider=afraid' "CFG_h1_url='https://example.com/x?y'"
	fresh; ddns update
	check "freedns.afraid.org: another site's URL refused, not fetched" sh -c "
		cat '$D'/state/h.* | grep -qx result=failed && ! grep -q '^URL https://example.com' '$D/curl.log'"

	# Cloudflare, global API key: the zone id once, PATCH only what differs
	resp 'https://api.ipify.org/|200|1.2.3.4' \
		'*/client/v4/zones?name=example.org|200|{"success":true,"result":[{"id":"0123abcd"}]}' \
		'*/zones/0123abcd/dns_records?type=A&name=www.example.org|200|{"success":true,"result":[{"id":"aa11","content":"1.2.3.4"}]}' \
		'*/zones/0123abcd/dns_records?type=A&name=missing.example.org|200|{"success":true,"result":[]}' \
		'*/zones/0123abcd/dns_records?type=A&name=example.org|200|{"success":true,"result":[{"id":"bb22","content":"192.0.2.1"}]}' \
		'*/zones/0123abcd/dns_records/bb22|200|{"success":true,"result":{"id":"bb22"}}' \
		'*/zones?name=bad.example|403|{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}'
	cfg 'CFG_SECTIONS_ddns_host=h1' 'CFG_h1_provider=cloudflare' "CFG_h1_hostname='www, @'" \
		'CFG_h1_zone=example.org' 'CFG_h1_email=me@example.org' 'CFG_h1_api_key=KEY123'
	fresh; ddns update
	check "Cloudflare: the changed record patched, the up-to-date one left" sh -c "
		[ \$(grep -c '^URL .*/dns_records/bb22\$' '$D/curl.log') -eq 1 ] && ! grep -q '^URL .*/dns_records/aa11' '$D/curl.log' &&
		grep '^ARGS' '$D/curl.log' | grep -q -- '-X PATCH' && grep -qF '{\"content\":\"1.2.3.4\"}' '$D/curl.log' &&
		cat '$D'/state/h.* | grep -qx result=good && cat '$D'/state/h.* | grep -qx zone_id=0123abcd"
	check "Cloudflare: e-mail and key as headers in curl's stdin config only" sh -c "
		grep -qF 'CFG header = \"X-Auth-Email: me@example.org\"' '$D/curl.log' &&
		grep -qF 'CFG header = \"X-Auth-Key: KEY123\"' '$D/curl.log' && ! grep '^ARGS' '$D/curl.log' | grep -q -e KEY123 -e me@"
	ddns update -f
	check "Cloudflare: the zone id reused" sh -c "[ \$(grep -c '^URL .*/zones?name=example.org' '$D/curl.log') -eq 1 ]"
	cfg 'CFG_SECTIONS_ddns_host=h1' 'CFG_h1_provider=cloudflare' 'CFG_h1_hostname=missing.example.org' \
		'CFG_h1_zone=example.org' 'CFG_h1_api_key=TOK456'
	fresh; ddns update
	check "Cloudflare API token: Bearer header; a missing A record reported, not created" sh -c "
		grep -qF 'CFG header = \"Authorization: Bearer TOK456\"' '$D/curl.log' &&
		cat '$D'/state/h.* | grep -qx result=failed && cat '$D'/state/h.* | grep -q 'no A record' &&
		! grep '^ARGS' '$D/curl.log' | grep -q -e PATCH -e POST"
	cfg 'CFG_SECTIONS_ddns_host=h1' 'CFG_h1_provider=cloudflare' 'CFG_h1_hostname=x' 'CFG_h1_zone=bad.example' 'CFG_h1_api_key=nope'
	fresh; ddns update
	check "Cloudflare: an authentication error is permanent, with the API's message" sh -c "
		cat '$D'/state/h.* | grep -qx result=failed && cat '$D'/state/h.* | grep -q 'Authentication error'"

	# GnuDIP: challenge, then the salted MD5 of the password
	resp 'https://api.ipify.org/|200|1.2.3.4' \
		'http://gnudip.example.net/gnudip/cgi-bin/gdipupdt.cgi?salt=*|200|<meta name="retc" content="0">' \
		'http://gnudip.example.net/gnudip/cgi-bin/gdipupdt.cgi|200|<meta name="salt" content="abc"><meta name="time" content="99"><meta name="sign" content="f00">'
	cfg 'CFG_SECTIONS_ddns_host=h1' 'CFG_h1_provider=gnudip' 'CFG_h1_hostname=me.dyn.example.net' \
		'CFG_h1_username=me' 'CFG_h1_password=pw' 'CFG_h1_server=gnudip.example.net'
	fresh; ddns update
	hp=$(printf '%s.abc' "$(printf pw | md5sum | cut -d ' ' -f 1)" | md5sum | cut -d ' ' -f 1)
	check "GnuDIP: salted password hash, user name and domain split" sh -c "
		grep -q '^URL .*salt=abc&time=99&sign=f00&user=me&pass=$hp&domn=dyn.example.net&reqc=0&addr=1.2.3.4' '$D/curl.log' &&
		cat '$D'/state/h.* | grep -qx result=good"

	# disabled entries, invalid names
	cfg 'CFG_SECTIONS_ddns_host="h1 h2"' 'CFG_h1_provider=noip' 'CFG_h1_hostname=a.example.net' 'CFG_h1_enabled=0' \
		'CFG_h1_username=u' 'CFG_h1_password=p' 'CFG_h2_provider=noip' "CFG_h2_hostname='bad\$(id).example.net'" \
		'CFG_h2_username=u' 'CFG_h2_password=p'
	fresh; ddns update
	check "a disabled entry skipped, an invalid host name never sent" sh -c "
		! grep -q '^URL https://dynupdate' '$D/curl.log' && cat '$D'/state/h.* | grep -q 'invalid host name'"

	# the stock client stays off
	sed "s|^logger|'$D/bin/logger'|" "$TOP/package/rtk-vendor/files/rtk/bin/updatedd" > "$D/updatedd"
	check "stock updatedd wrapper: exits without starting the stock client" sh -c "
		'$BB' sh '$D/updatedd' -- noip u:p host && grep -q 'not started' '$D/log' &&
		! grep -q '^[^#]*exec' '$TOP/package/rtk-vendor/files/rtk/bin/updatedd'"

	# ddns status: JSON through the router's jshn (busybox, jshn under qemu)
	local R="$TOP/build/stage"
	if command -v qemu-aarch64-static >/dev/null && [ -f "$R/usr/share/libubox/jshn.sh" ] && [ -x "$R/usr/bin/jshn" ]; then
		sed -e "s|/usr/share/libubox/jshn.sh|$R/usr/share/libubox/jshn.sh|" \
			-e "s|/usr/lib/nijika/common.sh|$LIB/common.sh|" "$D/ddns" > "$D/ddns.status"
		cfg 'CFG_SECTIONS_ddns_host="h1 h2"' 'CFG_h1_provider=noip' 'CFG_h1_hostname=a.example.net' \
			'CFG_h2_provider=cloudflare' 'CFG_h2_hostname=x'
		QEMU_LD_PREFIX="$R" PATH="$D/bin:$PATH:$R/usr/bin" qemu-aarch64-static -L "$R" "$R/bin/busybox" sh \
			"$D/ddns.status" status > "$D/status.json" 2>/dev/null
		pyjson "ddns status: JSON with the address check and every entry (router busybox + jshn)" "$D/status.json" \
			"d['kind'] == 'cgnat' and d['ip'] == '1.2.3.4' and set(d['hosts']) == {'h1', 'h2'} and d['running'] is False and d['stock'] == []"
	else
		skp "ddns status JSON" "no qemu-aarch64-static or build/stage"
	fi

	pyjson "menu: Services > DDNS after VoIP" "$TOP/package/luci-app-nijika/root/usr/share/luci/menu.d/luci-app-nijika.json" \
		"d['admin/services/ddns']['action']['path'] == 'nijika/ddns' and d['admin/services/ddns']['order'] > d['admin/services/voip']['order']"
	pyjson "ACL: ddns_status to read, ddns_update to write" "$TOP/package/luci-app-nijika/root/usr/share/rpcd/acl.d/luci-app-nijika.json" \
		"'ddns_status' in d['luci-app-nijika']['read']['ubus']['nijika'] and 'ddns_update' in d['luci-app-nijika']['write']['ubus']['nijika']"
}

# -------------------------------------------------------------- wireguard

t_wireguard() {
	echo "wireguard (wg0 config, routes, stock firewall rules, client configuration)"
	local D="$W/wg" out
	mkdir -p "$D/bin" "$D/state" "$D/kmod/5.10.70" "$D/sys/module" "$D/sys/class/net" "$D/rtk/proc/self"
	printf '%s\n' libchacha chacha-neon poly1305-neon libchacha20poly1305 libcurve25519-generic \
		libcurve25519 libblake2s-generic libblake2s wireguard > "$D/kmod/5.10.70/modules.load"
	mkdir -p "$D/sys/module/libchacha"	# already loaded: skipped
	# stock iptables in the chroot: rules kept in a file, -C/-I/-D on it
	cat > "$D/bin/rtkrun" <<RUN
#!/bin/sh
t=\${1##*/}; shift
[ "\$1" = -t ] && { tbl=\$2; shift 2; } || tbl=filter
op=\$1 chain=\$2; shift 2
[ "\$op" = -I ] && [ "\$1" = 1 ] && shift
line="\$t \$tbl \$chain \$*"
echo "\$op \$line" >> "$D/fw.log"
case "\$op" in
	-C) grep -qxF "\$line" "$D/rules" 2>/dev/null ;;
	-I) echo "\$line" >> "$D/rules" ;;
	-D) grep -qxF "\$line" "$D/rules" || exit 1
	    awk -v l="\$line" '!d && \$0 == l { d = 1; next } { print }' "$D/rules" > "$D/rules.t"; mv "$D/rules.t" "$D/rules" ;;
esac
RUN
	cat > "$D/bin/wg" <<WG
#!/bin/sh
case "\$1" in
	genkey) echo 'oK8WRRhd5gjB7CtYzS6Nd2l1/9bOkDiGXbFAfmeBnmM=' ;;
	genpsk) echo 'pSkpSkpSkpSkpSkpSkpSkpSkpSkpSkpSkpSkpSkpSkk=' ;;
	pubkey) read -r k; echo "PUB\${k%=}" ;;
	syncconf) cp "\$3" "$D/wg.synced" ;;
	show) printf 'priv\tpub\t51820\toff\n' ;;
esac
WG
	cat > "$D/bin/ddns" <<'DD'
#!/bin/sh
[ "$1" = wan ] && cat "${0%/ddns}/wan"
DD
	chmod +x "$D/bin/rtkrun" "$D/bin/wg" "$D/bin/ddns"
	cat > "$D/functions.sh" <<FN
config_load() { . "$D/cfg"; }
config_get() { eval "\$1=\\\${CFG_\${2}_\${3}-\\\$4}"; }
config_set() { eval "CFG_\$1_\$2=\\\$3"; }
config_get_bool() { local _v; config_get _v "\$2" "\$3" "\$4"; case "\$_v" in 1|on|true|yes|enabled) _v=1 ;; *) _v=0 ;; esac; eval "\$1=\\\$_v"; }
config_foreach() { local _s _l; eval "_l=\\\$CFG_SECTIONS_\$2"; for _s in \$_l; do "\$1" "\$_s"; done; }
# busybox sh would run its own applets
logger() { echo "\$*" >> "$D/log"; }
insmod() { echo "insmod \$*" >> "$D/calls"; mkdir -p "$D/sys/module/\$(basename "\$1" .ko | tr - _)"; }
uname() { echo 5.10.70; }
uci() {
	case "\$*" in
		*"get nijika.wireguard.private_key") echo "\$CFG_wireguard_private_key" ;;
		*"get nijika."*) s=\${*##*nijika.}; eval "echo \\\${CFG_\${s}_type}" ;;
		*) echo "uci \$*" >> "$D/calls" ;;
	esac
}
ip() {
	echo "ip \$*" >> "$D/calls"
	case "\$*" in
		*" rule del "*) return 1 ;;
		"-4 route show default") cat "$D/route" ;;
		"link add dev wg0 type wireguard") mkdir -p "$D/sys/class/net/wg0" ;;
		"link del dev wg0") rm -rf "$D/sys/class/net/wg0" ;;
		"-o addr show dev wg0") cat "$D/wgaddr" 2>/dev/null ;;
		"-4 -o addr show dev br0") echo '3: br0    inet 192.168.0.1/24 brd 192.168.0.255 scope global br0' ;;
		"-6 -o addr show scope global") cat "$D/addr6" 2>/dev/null ;;
	esac
	return 0
}
FN
	sed -e "s|^\. /lib/functions.sh|. $D/functions.sh|" -e "s|^STATE=.*|STATE=$D/state|" \
		-e "s|^KMOD=.*|KMOD=$D/kmod|" -e "s|^RTK_RUN=.*|RTK_RUN=$D/bin/rtkrun|" \
		-e "s|/sys/|$D/sys/|g" -e "s|/rtk/proc/self|$D/rtk/proc/self|" \
		-e "s|/usr/libexec/nijika/ddns|$D/bin/ddns|" -e "s|^LOADING=.*|LOADING=$D/etc/wireguard.loading|" \
		"$TOP/package/nijika/files/usr/libexec/nijika/wireguard" > "$D/wireguard"
	wg0() { PATH="$D/bin:$PATH" "$BB" sh "$D/wireguard" "$@"; }
	cfg() { printf '%s\n' "$@" > "$D/cfg"; }

	echo 'default via 100.64.0.1 dev ppp0 proto static' > "$D/route"
	mkdir -p "$D/sys/class/net/ppp0"; echo 1492 > "$D/sys/class/net/ppp0/mtu"
	printf 'wan=ppp0\nwan_ip=203.0.113.7\nkind=public\n' > "$D/bin/wan"
	cfg 'CFG_wireguard_enabled=1' 'CFG_wireguard_listen_port=51820' 'CFG_wireguard_address=10.7.0.1/24' \
		'CFG_SECTIONS_wireguard_peer="p1 p2 p3 p4"' \
		'CFG_p1_type=wireguard_peer' 'CFG_p1_public_key=PUBphone' 'CFG_p1_private_key=PRIVphone' 'CFG_p1_preshared_key=PSK1' \
		'CFG_p1_allowed_ips="10.7.0.2/32 fd07::2/128"' 'CFG_p1_client_allowed_ips="0.0.0.0/0"' \
		'CFG_p2_type=wireguard_peer' 'CFG_p2_public_key=PUBoffice' 'CFG_p2_allowed_ips="10.7.0.3/32 192.168.50.0/24 0.0.0.0/0"' \
		'CFG_p2_endpoint_host=2001:db8::5' 'CFG_p2_endpoint_port=51821' 'CFG_p2_persistent_keepalive=25' \
		'CFG_p3_type=wireguard_peer' 'CFG_p3_public_key=PUBoff' 'CFG_p3_enabled=0' 'CFG_p3_allowed_ips=10.7.0.9/32' \
		'CFG_p4_type=wireguard_peer' 'CFG_p4_allowed_ips=10.7.0.10/32' \
		'CFG_SECTIONS_ddns_host=d1' 'CFG_d1_provider=cloudflare' "CFG_d1_hostname='@, www'" 'CFG_d1_zone=example.org'
	rm -f "$D/calls" "$D/rules" "$D/fw.log"
	wg0 up
	check "up: a private key is made and stored when none is set" grep -q "uci -q set nijika.wireguard.private_key=" "$D/calls"
	check "up: the load marker is gone once the modules are in" test ! -e "$D/etc/wireguard.loading"
	check "up: modules loaded in modules.load order, the loaded one skipped" sh -c "
		[ \"\$(grep '^insmod' '$D/calls' | sed 's|.*/||' | tr '\n' ' ')\" = 'chacha-neon.ko poly1305-neon.ko libchacha20poly1305.ko libcurve25519-generic.ko libcurve25519.ko libblake2s-generic.ko libblake2s.ko wireguard.ko ' ]"
	check "up: wg0 created, MTU from the WAN (PPPoE 1492 - 80), its address set" sh -c "
		grep -qx 'ip link add dev wg0 type wireguard' '$D/calls' && grep -qx 'ip link set dev wg0 mtu 1412 up' '$D/calls' &&
		grep -qx 'ip -4 addr add 10.7.0.1/24 dev wg0' '$D/calls'"
	check "wg config: enabled peers with a key; allowed IPs, IPv6 endpoint in brackets, keepalive" sh -c "
		c='$D/wg.synced'; grep -qx 'ListenPort = 51820' \$c && grep -qx 'PublicKey = PUBphone' \$c &&
		grep -qx 'PresharedKey = PSK1' \$c && grep -qx 'AllowedIPs = 10.7.0.2/32, fd07::2/128' \$c &&
		grep -qx 'Endpoint = \[2001:db8::5\]:51821' \$c && grep -qx 'PersistentKeepalive = 25' \$c &&
		! grep -q PUBoff\$ \$c && [ \$(grep -c '^\[Peer\]' \$c) -eq 2 ] && ! grep -q PRIVphone \$c"
	check "routes: a site's LAN routed to wg0 (rule to the main table), not /32s in the subnet, never a default route" sh -c "
		grep -qx 'ip -4 route replace 192.168.50.0/24 dev wg0' '$D/calls' &&
		grep -qx 'ip -4 rule add to 192.168.50.0/24 lookup main pref 900' '$D/calls' &&
		grep -qx 'ip -4 rule add to 10.7.0.0/24 lookup main pref 900' '$D/calls' &&
		! grep -q 'route replace 10.7.0.3/32' '$D/calls' && ! grep -q 'route replace 0.0.0.0/0' '$D/calls' &&
		grep -qx 'ip -6 route replace fd07::2/128 dev wg0' '$D/calls'"
	check "firewall: UDP port, wg0 in and through (IPv4 and IPv6), NAT of the tunnel subnet out of the WAN" sh -c "
		r='$D/rules'; for t in iptables ip6tables; do
			grep -qx \"\$t filter INPUT -p udp --dport 51820 -j ACCEPT\" \$r && grep -qx \"\$t filter INPUT -i wg0 -j ACCEPT\" \$r &&
			grep -qx \"\$t filter FORWARD -i wg0 -j ACCEPT\" \$r && grep -qx \"\$t filter FORWARD -o wg0 -j ACCEPT\" \$r || exit 1
		done; grep -qx 'iptables nat POSTROUTING -s 10.7.0.0/24 -o ppp0 -j MASQUERADE' \$r && ! grep -q 'ip6tables nat' \$r"
	check "firewall: no extra NAT rule for peers inside the tunnel subnet" sh -c "[ \$(grep -c 'nat POSTROUTING' '$D/rules') -eq 2 ]"
	echo 'CFG_wireguard_private_key=oK8WRRhd5gjB7CtYzS6Nd2l1/9bOkDiGXbFAfmeBnmM=' >> "$D/cfg"
	echo 'CFG_wireguard_listen_port=51999' >> "$D/cfg"
	printf '%s\n' '7: wg0    inet 10.7.0.1/24 scope global wg0' > "$D/wgaddr"
	rm -f "$D/calls"
	wg0 up
	check "up again, new port: the old port's rule removed, the rest kept once" sh -c "
		r='$D/rules'; ! grep -q 'dport 51820' \$r && grep -qx 'iptables filter INPUT -p udp --dport 51999 -j ACCEPT' \$r &&
		[ \$(grep -c 'iptables filter FORWARD -i wg0 -j ACCEPT' \$r) -eq 1 ] && ! grep -q 'addr add' '$D/calls' &&
		! grep -q 'link add' '$D/calls' && ! grep -q '^insmod' '$D/calls' && ! grep -q 'uci -q set' '$D/calls'"
	sort "$D/rules" > "$D/rules.sorted"; : > "$D/rules"
	wg0 firewall
	check "firewall (housekeep): rules the stock startup dropped come back" sh -c "sort '$D/rules' | cmp -s - '$D/rules.sorted'"

	# client configuration
	out=$(wg0 client p1)
	check "client config: own key, /32 and /128 address, DNS = LAN address, router key, DDNS endpoint, keepalive" sh -c "
		echo '$out' | grep -qx 'PrivateKey = PRIVphone' && echo '$out' | grep -qx 'Address = 10.7.0.2/32, fd07::2/128' &&
		echo '$out' | grep -qx 'DNS = 192.168.0.1' && echo '$out' | grep -qx 'PublicKey = PUBoK8WRRhd5gjB7CtYzS6Nd2l1/9bOkDiGXbFAfmeBnmM' &&
		echo '$out' | grep -qx 'AllowedIPs = 0.0.0.0/0' && echo '$out' | grep -qx 'Endpoint = example.org:51999' &&
		echo '$out' | grep -qx 'PresharedKey = PSK1' && echo '$out' | grep -qx 'PersistentKeepalive = 25'"
	check "client config: refused without the peer's private key, and for a bad section name" sh -c "
		! PATH='$D/bin:$PATH' '$BB' sh '$D/wireguard' client p2 >/dev/null 2>&1 &&
		! PATH='$D/bin:$PATH' '$BB' sh '$D/wireguard' client 'p1;id' >/dev/null 2>&1"
	# a /32 tunnel address (peers outside it): their addresses are NATed too
	sed 's|^CFG_wireguard_address=.*|CFG_wireguard_address=192.168.89.24/32|; s|10\.7\.0\.|192.168.89.|g' "$D/cfg" > "$D/cfg32"
	cp "$D/cfg" "$D/cfg.keep"; cp "$D/cfg32" "$D/cfg"; : > "$D/rules"; rm -f "$D/state/fw"
	wg0 firewall
	check "firewall: a /32 tunnel address: the peers' addresses masqueraded (not disabled or keyless ones)" sh -c "
		r='$D/rules'; for s in 192.168.89.2/32 192.168.89.3/32 192.168.50.0/24; do
			grep -qx \"iptables nat POSTROUTING -s \$s -o ppp0 -j MASQUERADE\" \$r || exit 1
		done; ! grep -q -e '192.168.89.9/32' -e '192.168.89.10/32' -e '192.168.89.24/32' \$r"
	cp "$D/cfg.keep" "$D/cfg"; : > "$D/rules"; rm -f "$D/state/fw"; wg0 firewall
	sed -i '/^CFG_SECTIONS_ddns_host=/d' "$D/cfg"
	printf 'wan=ppp0\nwan_ip=100.70.12.34\nkind=cgnat\n' > "$D/bin/wan"
	echo '2: br0    inet6 2001:db8:1::1/64 scope global dynamic' > "$D/addr6"
	out=$(wg0 client p1)
	check "behind CGNAT, no DDNS name: the router's IPv6 address as endpoint" sh -c "echo '$out' | grep -qx 'Endpoint = \[2001:db8:1::1\]:51999'"
	printf 'wan=ppp0\nwan_ip=5.6.7.8\nkind=public\n' > "$D/bin/wan"
	out=$(wg0 client p1)
	check "public WAN, no DDNS name: the WAN address as endpoint" sh -c "echo '$out' | grep -qx 'Endpoint = 5.6.7.8:51999'"

	rm -f "$D/calls"
	wg0 down
	check "down: rules, routes and wg0 removed" sh -c "
		[ ! -s '$D/rules' ] && grep -qx 'ip link del dev wg0' '$D/calls' &&
		grep -q 'ip -4 route del 192.168.50.0/24 dev wg0' '$D/calls' && [ ! -d '$D/sys/class/net/wg0' ]"

	# a load that crashed the kernel: not tried again at the next start
	rm -rf "$D/sys/module"/* "$D/state/error"; : > "$D/calls"
	mkdir -p "$D/etc"; echo crashed > "$D/etc/wireguard.loading"
	check "an unfinished module load (crash) is not repeated: up refuses, says how to retry" sh -c "
		! PATH='$D/bin:$PATH' '$BB' sh '$D/wireguard' up 2>/dev/null && grep -q 'did not finish' '$D/state/error' &&
		! grep -q '^insmod' '$D/calls'"
	PATH="$D/bin:$PATH" "$BB" sh "$D/wireguard" retry 2>/dev/null
	check "retry: loads the modules again and clears the marker" sh -c "
		grep -q '^insmod.*wireguard.ko' '$D/calls' && [ ! -e '$D/etc/wireguard.loading' ]"

	rm -rf "$D/kmod/5.10.70"; rm -rf "$D/sys/module"/*
	check "no module for the running kernel: up fails with a clear error" sh -c "
		! PATH='$D/bin:$PATH' '$BB' sh '$D/wireguard' up 2>/dev/null && grep -q 'no WireGuard module for kernel 5.10.70' '$D/state/error'"

	pyjson "menu: Services > WireGuard after DDNS" "$TOP/package/luci-app-nijika/root/usr/share/luci/menu.d/luci-app-nijika.json" \
		"d['admin/services/wireguard']['action']['path'] == 'nijika/wireguard' and d['admin/services/wireguard']['order'] > d['admin/services/ddns']['order']"
	pyjson "ACL: wg_status to read, wg_keys and wg_client (private keys) to write" "$TOP/package/luci-app-nijika/root/usr/share/rpcd/acl.d/luci-app-nijika.json" \
		"'wg_status' in d['luci-app-nijika']['read']['ubus']['nijika'] and {'wg_keys', 'wg_client'} <= set(d['luci-app-nijika']['write']['ubus']['nijika']) and 'wg_client' not in d['luci-app-nijika']['read']['ubus']['nijika']"
}

# ------------------------------------------------------------------- kmod

# the modules built for the stock kernel (./build.sh kmod)
t_kmod() {
	echo "kmod (modules for the stock kernel: vermagic, symbols, load order)"
	local K="$TOP/build/kmod/5.10.70" S="$TOP/build/kmod/stock-kernel" X m
	X=$(ls -d "$TOP"/build/toolchain/*/bin 2>/dev/null | head -n 1)
	if [ ! -f "$K/modules.load" ] || [ ! -f "$S/vmlinux.symvers" ] || [ -z "$X" ]; then
		skp "kernel modules" "not built (./build.sh kmod)"
		return
	fi
	X="$X/aarch64-linux-"
	modinfo() { "${X}objcopy" -O binary --only-section=.modinfo "$1" /dev/stdout 2>/dev/null | tr '\0' '\n' | sed -n "s/^$2=//p"; }

	check "vermagic of every module = the stock kernel's (5.10.70 SMP mod_unload aarch64)" sh -c "
		for k in '$K'/*.ko; do
			[ \"\$('${X}objcopy' -O binary --only-section=.modinfo \"\$k\" /dev/stdout | tr '\0' '\n' | sed -n 's/^vermagic=//p')\" = '5.10.70 SMP mod_unload aarch64' ] || exit 1
		done"
	for k in "$K"/*.ko; do "${X}nm" "$k" | awk '$3 ~ /^__ksymtab_/ { sub(/^__ksymtab_/, "", $3); print $3 }'; done | sort -u > "$W/kmod.exp"
	for k in "$K"/*.ko; do "${X}nm" -u "$k" | awk '{ print $2 }'; done | sort -u > "$W/kmod.undef"
	cut -f 2 "$S/vmlinux.symvers" | sort -u > "$W/kmod.vmlinux"
	check "every symbol the modules need: exported by the stock kernel or by one of them" \
		sh -c "[ -z \"\$(comm -23 '$W/kmod.undef' \$(printf '%s\n' '$W/kmod.exp' '$W/kmod.vmlinux' | xargs sort -u | tee '$W/kmod.have' >/dev/null; echo '$W/kmod.have'))\" ]"
	check "modules.load: every module once, dependencies first" sh -c "
		[ \"\$(ls '$K' | sed -n 's/\.ko\$//p' | sort | tr '\n' ' ')\" = \"\$(sort '$K/modules.load' | tr '\n' ' ')\" ] || exit 1
		seen=' '
		while read -r m; do
			for d in \$('${X}objcopy' -O binary --only-section=.modinfo '$K'/\$m.ko /dev/stdout | tr '\0' '\n' | sed -n 's/^depends=//p' | tr ',' ' '); do
				case \"\$seen\" in *\" \$d \"*|*\" \$(echo \$d | tr _ -) \"*) ;; *) exit 1 ;; esac
			done
			seen=\"\$seen\$m \"
		done < '$K/modules.load'"
	check "WireGuard and the NEON ChaCha20/Poly1305 are among them" sh -c "
		grep -qx wireguard '$K/modules.load' && grep -qx chacha-neon '$K/modules.load' && grep -qx poly1305-neon '$K/modules.load'"
	if [ -d "$TOP/build/stage/rtk/lib/modules" ]; then
		find "$TOP/build/stage/rtk/lib/modules" -name '*.ko' > "$W/kmod.stock"
		while read -r k; do "${X}nm" -u "$k"; done < "$W/kmod.stock" | awk '{ print $2 }' | sort -u > "$W/kmod.sundef"
		while read -r k; do "${X}nm" "$k" | awk '$3 ~ /^__ksymtab_/ { sub(/^__ksymtab_/, "", $3); print $3 }'; done < "$W/kmod.stock" | sort -u > "$W/kmod.sexp"
		check "ksymtab.py: the stock kernel's exports cover what all stock modules import" sh -c "
			[ -z \"\$(comm -23 '$W/kmod.sundef' \$(sort -u '$W/kmod.sexp' '$W/kmod.vmlinux' > '$W/kmod.shave'; echo '$W/kmod.shave'))\" ]"
	else
		skp "ksymtab.py against the stock modules" "no build/stage"
	fi
}

# --------------------------------------------------------------- lanmgmt

# lan-mgmt: LAN access to SSH/LuCI, the stock GUI's ports, ping from the WAN
t_lanmgmt() {
	echo "lanmgmt (router access rules in the stock iptables, ping from the WAN)"
	local D="$W/lanmgmt"
	mkdir -p "$D"
	# the stock iptables in the chroot: rules in a file, -C/-I/-D on it
	cat > "$D/run" <<RUN
#!/bin/sh
t=\${1##*/}; shift
op=\$1 chain=\$2; shift 2
[ "\$op" = -I ] && [ "\$1" = 1 ] && shift
line="\$t \$chain \$*"
case "\$op" in
	-C) grep -qxF -- "\$line" "$D/rules" 2>/dev/null ;;
	-I) echo "\$line" >> "$D/rules" ;;
	-D) grep -qxF -- "\$line" "$D/rules" || exit 1
	    awk -v l="\$line" '!d && \$0 == l { d = 1; next } { print }' "$D/rules" > "$D/rules.t"; mv "$D/rules.t" "$D/rules" ;;
esac
RUN
	chmod +x "$D/run"
	cat > "$D/functions.sh" <<FN
config_load() { . "$D/cfg"; }
config_get() { eval "\$1=\\\${CFG_\${2}_\${3}-\\\$4}"; }
config_get_bool() { local _v; config_get _v "\$2" "\$3" "\$4"; case "\$_v" in 1|on|true|yes|enabled) _v=1 ;; *) _v=0 ;; esac; eval "\$1=\\\$_v"; }
FN
	sed -e "s|^\. /lib/functions.sh|. $D/functions.sh|" -e "s|/usr/libexec/rtk/run|$D/run|g" \
		-e "s|/rtk/home/httpd/boa.conf|$D/boa.conf|" \
		"$TOP/package/rtk-vendor/files/usr/libexec/rtk/lan-mgmt" > "$D/lan-mgmt"
	echo 'Port 8080' > "$D/boa.conf"
	lm() { "$BB" sh "$D/lan-mgmt"; }

	: > "$D/cfg"; : > "$D/rules"
	lm
	check "defaults: SSH/LuCI from the LAN, stock GUI ports closed to all but the router itself" sh -c "
		r='$D/rules'; grep -qx 'iptables INPUT -i br0 -p tcp --dport 22 -j ACCEPT' \$r &&
		grep -qx 'ip6tables INPUT -i br0 -p tcp --dport 80 -j ACCEPT' \$r &&
		grep -qx 'iptables INPUT ! -i lo -p tcp --dport 8080 -j DROP' \$r && grep -qx 'iptables INPUT ! -i lo -p tcp --dport 443 -j DROP' \$r"
	check "default: ping from the WAN answered (IPv4 and IPv6, rate-limited), not the LAN rule" sh -c "
		r='$D/rules'; grep -qx 'iptables INPUT ! -i br0 -p icmp --icmp-type echo-request -m limit --limit 10/s --limit-burst 20 -j ACCEPT' \$r &&
		grep -qx 'ip6tables INPUT ! -i br0 -p icmpv6 --icmpv6-type echo-request -m limit --limit 10/s --limit-burst 20 -j ACCEPT' \$r &&
		! grep -q 'ip6tables INPUT .*-p icmp --icmp-type' \$r"
	n=$(wc -l < "$D/rules")
	lm
	check "run again (housekeep every minute): nothing added twice" sh -c "[ \$(wc -l < '$D/rules') -eq $n ]"
	echo "CFG_firewall_wan_ping=0" > "$D/cfg"
	lm
	check "wan_ping off: the ping rules removed, the rest kept" sh -c "
		! grep -q echo-request '$D/rules' && grep -q 'dport 22 -j ACCEPT' '$D/rules'"
}

# ------------------------------------------------------------------- main

groups="${*:-syntax json lint parsers wrapper ucimirror spi lanmgmt apply easymesh ddns wireguard kmod helpers stockshell bootenv fwu banner theme}"
for g in $groups; do
	case "$g" in
		syntax|json|lint|parsers|wrapper|ucimirror|spi|lanmgmt|apply|easymesh|ddns|wireguard|kmod|helpers|stockshell|bootenv|fwu|banner|theme) "t_$g" ;;
		*) echo "unknown group: $g"; exit 2 ;;
	esac
done
echo
echo "passed $pass, failed $fail, skipped $skip"
[ "$fail" -eq 0 ]
