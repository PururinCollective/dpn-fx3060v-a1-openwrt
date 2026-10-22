# SPDX-License-Identifier: GPL-2.0-only

# shellcheck shell=ash
# PON / ONT status collection. Requires common.sh and omci.sh.

# Extract a number from a diag transceiver line, normalise the unit and
# round it to <decimals>.
#   "Rx Power: -16.270880 dBm" / "-inf dBm" / "0.0107 mW" / "10.7 uW" -> dBm
#   "Temperature: 25.949219 C", "Voltage: 3.276000 V", "Bias Current: 14.15 mA"
_pon_num() {
	awk -v kind="$1" -v dec="${2:-2}" '
	function num(s,   v) { if (match(s, /-?[0-9]+(\.[0-9]+)?/)) return substr(s, RSTART, RLENGTH); return "" }
	function out(v) { printf("%." dec "f\n", v); exit }
	{
		line = $0
		p = index(line, ":"); if (p) line = substr(line, p + 1)
		if (kind == "power") {
			if (line ~ /-inf/) { print "-inf"; exit }
			if (match(line, /-?[0-9]+(\.[0-9]+)? *dBm/)) out(num(substr(line, RSTART, RLENGTH)))
			if (match(line, /-?[0-9]+(\.[0-9]+)? *[mM][wW]/)) {
				v = num(substr(line, RSTART, RLENGTH)) + 0
				if (v > 0) out(10 * log(v) / log(10)); print "-inf"; exit
			}
			if (match(line, /-?[0-9]+(\.[0-9]+)? *[uU][wW]/)) {
				v = num(substr(line, RSTART, RLENGTH)) + 0
				if (v > 0) out(10 * log(v / 1000) / log(10)); print "-inf"; exit
			}
		}
		v = num(line); if (v != "") out(v)
	}'
}

# "ONU state: Initial State:Off-Sync(O1.1)". This SoC (RTL9607DQ) answers
# through the rt_gpon API; the older "gpon" diag tree reports "driver not
# found" here but is kept as a fallback for other Realtek ONUs.
pon_onu_state_raw() {
	local raw
	raw=$(diag rt_gpon get onu-state)
	case "$raw" in *"(O"[0-9]*) ;; *) raw=$(diag gpon get onu-state) ;; esac
	printf '%s\n' "$raw"
}

pon_state_text() {
	case "$1" in
		O1.1) echo "initial (off-sync)" ;;
		O1.2) echo "initial (profile learning)" ;;
		O1*) echo "initial" ;;
		O2*) echo "standby" ;;
		O3*) echo "serial-number" ;;
		O4*) echo "ranging" ;;
		O5*) echo "operational" ;;
		O6*) echo "intermittent-LODS" ;;
		O7*) echo "emergency-stop" ;;
		*) echo "unknown" ;;
	esac
}

# Collect live PON status and print it as shell assignments (PON_*='...').
pon_collect_env() {
	local raw state rx tx temp volt bias olt_hex olt alarms los sn vendor

	raw=$(pon_onu_state_raw)
	state=$(printf '%s\n' "$raw" | sed -n 's/.*(\(O[0-9][0-9.]*\)).*/\1/p' | head -n 1)

	rx=$(diag pon get transceiver rx-power | _pon_num power 2)
	tx=$(diag pon get transceiver tx-power | _pon_num power 2)
	temp=$(diag pon get transceiver temperature | _pon_num plain 1)
	volt=$(diag pon get transceiver voltage | _pon_num plain 2)
	bias=$(diag pon get transceiver bias-current | _pon_num plain 1)

	# No alarm read-out on this SoC (rt_gpon has none); loss of signal is
	# what the transceiver reports as no light.
	case "$rx" in -inf|'') los=1; alarms="LOS=yes;" ;; *) los=0; alarms="LOS=no;" ;; esac

	olt_hex=$(omci_get 131 | awk -F': *' '/^OltVendorId/ { print $2; exit }')
	[ -n "$olt_hex" ] && olt=$(hex_to_ascii "$olt_hex")

	sn=$(mib_get GPON_SN)
	vendor=$(mib_get PON_VENDOR_ID)

	q() { printf "%s='%s'\n" "$1" "$(printf '%s' "$2" | sed "s/'/'\\\\''/g")"; }
	q PON_STATE "$state"
	q PON_STATE_TEXT "$(pon_state_text "$state")"
	q PON_LOS "$los"
	q PON_RX_DBM "$rx"
	q PON_TX_DBM "$tx"
	q PON_TEMP_C "$temp"
	q PON_VOLTAGE_V "$volt"
	q PON_BIAS_MA "$bias"
	q PON_ALARMS "$alarms"
	q PON_OLT_VENDOR "$olt"
	q PON_OLT_VENDOR_HEX "$olt_hex"
	q PON_SN "$sn"
	q PON_VENDOR_ID "$vendor"
	q PON_UPDATED "$(date +%s)"
}

# Print the env file as JSON (input: PON_* assignments on stdin).
pon_env_to_json() {
	(
		. /usr/share/libubox/jshn.sh
		eval "$(cat)"
		json_init
		json_add_string state "$PON_STATE"
		json_add_string state_text "$PON_STATE_TEXT"
		json_add_boolean los "${PON_LOS:-0}"
		json_add_string rx_dbm "$PON_RX_DBM"
		json_add_string tx_dbm "$PON_TX_DBM"
		json_add_string temp_c "$PON_TEMP_C"
		json_add_string voltage_v "$PON_VOLTAGE_V"
		json_add_string bias_ma "$PON_BIAS_MA"
		json_add_array alarms
		local IFS=';' a
		for a in $PON_ALARMS; do
			[ -n "$a" ] || continue
			json_add_object
			json_add_string name "${a%%=*}"
			json_add_string status "${a#*=}"
			json_close_object
		done
		json_close_array
		json_add_string olt_vendor "$PON_OLT_VENDOR"
		json_add_string olt_vendor_hex "$PON_OLT_VENDOR_HEX"
		json_add_string sn "$PON_SN"
		json_add_string vendor_id "$PON_VENDOR_ID"
		json_add_int updated "${PON_UPDATED:-0}"
		json_add_int uptime "$(cut -d. -f1 /proc/uptime)"
		json_dump
	)
}

# Refresh the cache in $NIJIKA_RUNDIR (atomic replace).
pon_refresh_cache() {
	mkdir -p "$NIJIKA_RUNDIR"
	pon_collect_env > "$NIJIKA_RUNDIR/pon.env.$$" &&
		mv "$NIJIKA_RUNDIR/pon.env.$$" "$NIJIKA_RUNDIR/pon.env"
	pon_env_to_json < "$NIJIKA_RUNDIR/pon.env" > "$NIJIKA_RUNDIR/pon.json.$$" &&
		mv "$NIJIKA_RUNDIR/pon.json.$$" "$NIJIKA_RUNDIR/pon.json"
}

# Cache lifetime in seconds (uci nijika.pon.cache_ttl, default 5).
pon_cache_ttl() {
	local ttl
	ttl=$(uci -q get nijika.pon.cache_ttl)
	case "$ttl" in ''|*[!0-9]*) ttl=5 ;; esac
	echo "$ttl"
}

# True when the cache is missing or older than $1 seconds.
pon_cache_stale() {
	local ts
	ts=$(sed -n "s/^PON_UPDATED='\(.*\)'$/\1/p" "$NIJIKA_RUNDIR/pon.env" 2>/dev/null)
	[ -z "$ts" ] || [ $(( $(date +%s) - ts )) -ge "$1" ]
}

# On-demand status: nothing polls in the background. Callers (LuCI, `nijika
# info`, the login banner) get the cached values, refreshed first when older
# than $1 seconds (default: pon_cache_ttl). Concurrent callers share one
# refresh: the lock holder runs diag, the others wait and re-check.
pon_cached_env() {
	local max="${1:-$(pon_cache_ttl)}"
	if pon_cache_stale "$max" && vendor_up; then
		mkdir -p "$NIJIKA_RUNDIR"
		(
			flock -x 9
			pon_cache_stale "$max" && pon_refresh_cache
		) 9>"$NIJIKA_RUNDIR/pon.lock"
	fi
	cat "$NIJIKA_RUNDIR/pon.env" 2>/dev/null
}
