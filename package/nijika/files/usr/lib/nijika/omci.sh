# shellcheck shell=ash
# OMCI MIB access through the stock omcicli. Requires common.sh.
#
# omcicli hands the request to omci_app and reads the answer from a temp
# file, waiting only a short while: a big answer (mib get all, 200+ priority
# queues) comes back cut off and the rest spills into the NEXT omcicli call.
# So: one class per request, serialised by a lock, and every answer is
# checked against the table name it must start with.

# Expected omcicli table name per G.988 class (see `omcicli get tables`).
omci_table_name() {
	case "$1" in
		2) echo OntData ;; 5) echo Cardholder ;; 6) echo CircuitPack ;;
		7) echo SWImage ;; 11) echo EthUni ;; 45) echo MacBriServProf ;;
		47) echo MacBriPortCfgData ;; 49) echo MacBridgePortFilterTable ;;
		53) echo PotsUni ;; 79) echo MacBridgePortFilterPreassign ;;
		84) echo VlanTagFilterData ;; 130) echo Map8021pServProf ;;
		131) echo OltG ;; 134) echo IpHostCfgData ;; 136) echo TcpUdpCfgData ;;
		171) echo ExtVlanTagOperCfgData ;; 256) echo Ontg ;; 257) echo Ont2g ;;
		262) echo Tcont ;; 263) echo Anig ;; 264) echo Unig ;;
		266) echo GemIwTp ;; 268) echo GemPortCtp ;; 272) echo GalEthProf ;;
		277) echo PriQ ;; 278) echo Scheduler ;; 280) echo TrafficDescriptor ;;
		281) echo MultiGemIwTp ;; 309) echo McastOperProf ;;
		310) echo McastSubConfInfo ;; 311) echo McastSubMonitor ;;
		329) echo VEIP ;; 340) echo TR069ManageServer ;;
	esac
}

# omci_get CLASS -> raw omcicli text (caller holds the lock)
_omci_get_unlocked() {
	local cls="$1" want raw first try=0
	want=$(omci_table_name "$cls")
	while :; do
		raw=$(omcicli mib get "$cls")
		first=$(printf '%s\n' "$raw" | sed -n '2p' | tr -d '\r')
		if [ -z "$want" ] || [ -z "$raw" ] || [ "$first" = "$want" ]; then
			break
		fi
		# leftovers of an earlier, cut-off answer: let omci_app finish
		try=$((try + 1))
		[ $try -ge 3 ] && break
		sleep 2
	done
	printf '%s\n' "$raw"
	# A cut-off answer (it stops inside an instance) is still being written
	# by omci_app: give it time before the next request. Complete answers end
	# with a "=====" separator, or with the "XXXX" header when the class has
	# no instance (nothing provisioned, e.g. without fibre).
	case "$(printf '%s\n' "$raw" | grep -v '^[[:space:]]*$' | tail -n 1)" in
		=*|X*|'') ;;
		*) sleep 2 ;;
	esac
}

omci_lock() {
	mkdir -p "$NIJIKA_RUNDIR"
	exec 8>"$NIJIKA_RUNDIR/omci.lock"
	flock -x 8
}

omci_unlock() {
	flock -u 8 2>/dev/null
	exec 8>&-
}

omci_get() {
	( omci_lock; _omci_get_unlocked "$1" )
}

# omci_me_json CLASS -> {"class":..,"name":..,"instances":[..],"truncated":..}
omci_me_json() {
	omci_get "$1" | awk -v class="$1" -f "$NIJIKA_LIB/me.awk"
}

# `omcicli dump qmap` -> JSON {pq:[..], tcont:[..], us:[..], ds:[..]}
# Only queues in use and T-CONTs that carry an Alloc-ID are listed.
omci_qmap_json() {
	omcicli dump qmap | awk -f "$NIJIKA_LIB/qmap.awk"
}

# Everything the Provisioning page draws, as one JSON object.
OMCI_MAP_CLASSES="131 256 262 268 266 281 130 47 45 84 171 11 329 309 310"
OMCI_MAP_TTL=30

omci_map_refresh() {
	local c out="$NIJIKA_RUNDIR/omci_map.json" tmp sep=""
	tmp="$out.$$"
	{
		printf '{"updated":%s,"me":{' "$(date +%s)"
		for c in $OMCI_MAP_CLASSES; do
			printf '%s"%s":' "$sep" "$c"
			_omci_get_unlocked "$c" | awk -v class="$c" -f "$NIJIKA_LIB/me.awk" | tr -d '\n'
			sep=","
		done
		printf '},"qmap":'
		omcicli dump qmap | awk -f "$NIJIKA_LIB/qmap.awk" | tr -d '\n'
		printf '}\n'
	} > "$tmp" && mv "$tmp" "$out"
}

omci_map_json() {
	local out="$NIJIKA_RUNDIR/omci_map.json" age=999999 now
	now=$(date +%s)
	[ -f "$out" ] && age=$((now - $(date -r "$out" +%s 2>/dev/null || echo 0)))
	if [ "$age" -ge "$OMCI_MAP_TTL" ] && vendor_up; then
		(
			omci_lock
			# another request may have refreshed it while we waited
			age=999999
			[ -f "$out" ] && age=$(( $(date +%s) - $(date -r "$out" +%s 2>/dev/null || echo 0) ))
			[ "$age" -ge "$OMCI_MAP_TTL" ] && omci_map_refresh
		)
	fi
	cat "$out" 2>/dev/null
}
