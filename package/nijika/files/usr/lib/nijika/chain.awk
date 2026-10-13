# `flash get <CHAIN_TBL>` -> JSON
#   {"table":"ATM_VC_TBL","num":4,"records":[{"ifIndex":"...",...},...]}
# Stock output: "<TBL>.NUM=4" (only for "get <TBL>.NUM"), then per record
# "<TBL>.<i>:" followed by "%-18s = %s" lines ("vid                = 500").
# Plain "field=value" lines are accepted too.
# Usage: flash get ATM_VC_TBL | awk -v table=ATM_VC_TBL -f chain.awk

# JSON string. A character loop on purpose: busybox 1.37 awk drops the
# backslash from gsub() replacements ("\\\"" comes out as a bare quote).
# Other control characters (ANSI colours from the stock tools) are dropped.
function jstr(s,   o, i, c, n) {
	if (s !~ /[\\"[:cntrl:]]/) return "\"" s "\""
	o = ""; n = length(s)
	for (i = 1; i <= n; i++) {
		c = substr(s, i, 1)
		if (c == "\\") o = o "\\\\"
		else if (c == "\"") o = o "\\\""
		else if (c == "\n") o = o "\\n"
		else if (c == "\t") o = o "\\t"
		else if (c !~ /[[:cntrl:]]/) o = o c
	}
	return "\"" o "\""
}
function close_rec() {
	if (inrec) { recs = recs (nrec++ ? "," : "") "{" fields "}"; fields = ""; nf_ = 0 }
	inrec = 0
}

BEGIN { num = -1; recs = ""; nrec = 0; inrec = 0; fields = ""; nf_ = 0 }

{ line = $0; sub(/\r$/, "", line); sub(/^[ \t]+/, "", line) }

line ~ /\.NUM=[0-9]+$/ { num = substr(line, index(line, "=") + 1) + 0; next }

line ~ /\.[0-9]+:$/ { close_rec(); inrec = 1; next }

inrec && line ~ /^[A-Za-z_][A-Za-z0-9_.]*[ \t]*=/ {
	p = index(line, "=")
	k = substr(line, 1, p - 1); v = substr(line, p + 1)
	# padded form: drop the padding and the single space after "=" (a value
	# may itself start with spaces, e.g. an SSID)
	if (k ~ /[ \t]$/) { sub(/[ \t]+$/, "", k); sub(/^ /, "", v) }
	sub(/^.*\./, "", k)
	fields = fields (nf_++ ? "," : "") jstr(k) ":" jstr(v)
}

END {
	close_rec()
	if (num < 0) num = nrec
	printf "{\"table\":%s,\"num\":%d,\"records\":[%s]}\n", jstr(table), num, recs
}
