# shellcheck shell=ash
# PON / ONT status collection. Requires common.sh.

# Extract a number from a diag transceiver line and normalise the unit.
#   "Rx Power: -19.70 dBm" / "0.0107 mW" / "10.7 uW"  -> dBm
#   "Temperature: 45.5 C", "Voltage: 3.30 V", "Bias Current: 12.0 mA"
_pon_num() {
	awk -v kind="$1" '
	function num(s,   v) { if (match(s, /-?[0-9]+(\.[0-9]+)?/)) return substr(s, RSTART, RLENGTH); return "" }
	{
		line = $0
		p = index(line, ":"); if (p) line = substr(line, p + 1)
		if (kind == "power") {
			if (match(line, /-?[0-9]+(\.[0-9]+)? *dBm/)) { print num(substr(line, RSTART, RLENGTH)); exit }
			if (match(line, /-?[0-9]+(\.[0-9]+)? *[mM][wW]/)) {
				v = num(substr(line, RSTART, RLENGTH)) + 0
				if (v > 0) printf "%.2f\n", 10 * log(v) / log(10); else print "-inf"; exit
			}
			if (match(line, /-?[0-9]+(\.[0-9]+)? *[uU][wW]/)) {
				v = num(substr(line, RSTART, RLENGTH)) + 0
				if (v > 0) printf "%.2f\n", 10 * log(v / 1000) / log(10); else print "-inf"; exit
			}
		}
		v = num(line); if (v != "") { print v; exit }
	}'
}

pon_state_text() {
	case "$1" in
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

	raw=$(diag gpon get onu-state)
	state=$(printf '%s\n' "$raw" | sed -n 's/.*(\(O[0-9][0-9.]*\)).*/\1/p' | head -n 1)

	rx=$(diag pon get transceiver rx-power | _pon_num power)
	tx=$(diag pon get transceiver tx-power | _pon_num power)
	temp=$(diag pon get transceiver temperature | _pon_num plain)
	volt=$(diag pon get transceiver voltage | _pon_num plain)
	bias=$(diag pon get transceiver bias-current | _pon_num plain)

	alarms=$(diag gpon get alarm-status | sed -n 's/^Alarm \(.*\), status: \(.*\)$/\1=\2/p' | tr '\n' ';')
	case ";$alarms" in *";LOS=yes;"*) los=1 ;; *) los=0 ;; esac

	olt_hex=$(omcicli mib get 131 | awk -F': *' '/^OltVendorId/ { print $2; exit }')
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

# Return cached env, refreshing it when older than $1 seconds (default 10).
pon_cached_env() {
	local max="${1:-10}" now ts
	now=$(date +%s)
	ts=$(sed -n "s/^PON_UPDATED='\(.*\)'$/\1/p" "$NIJIKA_RUNDIR/pon.env" 2>/dev/null)
	if [ -z "$ts" ] || [ $((now - ts)) -gt "$max" ]; then
		vendor_up && pon_refresh_cache
	fi
	cat "$NIJIKA_RUNDIR/pon.env" 2>/dev/null
}
