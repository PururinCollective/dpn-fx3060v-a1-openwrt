#!/bin/sh
# NijikaWrt offline regression tests: no router needed.
#
#   tests/run.sh                 every group
#   tests/run.sh parsers fwu     some groups
#
# Groups: syntax json lint parsers wrapper ucimirror bootenv fwu banner
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
}

# --------------------------------------------- stock dnsmasq DoH wrapper

t_wrapper() {
	echo "wrapper (stock dnsmasq, DNS over HTTPS)"
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

# ------------------------------------------------------------------- main

groups="${*:-syntax json lint parsers wrapper ucimirror bootenv fwu banner}"
for g in $groups; do
	case "$g" in
		syntax|json|lint|parsers|wrapper|ucimirror|bootenv|fwu|banner) "t_$g" ;;
		*) echo "unknown group: $g"; exit 2 ;;
	esac
done
echo
echo "passed $pass, failed $fail, skipped $skip"
[ "$fail" -eq 0 ]
