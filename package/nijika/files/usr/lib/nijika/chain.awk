# `flash get <CHAIN_TBL>` -> JSON
#   {"table":"ATM_VC_TBL","num":4,"records":[{"ifIndex":"...",...},...]}
# Stock output: "<TBL>.NUM=4", then per record "<TBL>.<i>:" followed by
# "field=value" lines.
# Usage: flash get ATM_VC_TBL | awk -v table=ATM_VC_TBL -f chain.awk

function jstr(s) {
	gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); gsub(/\t/, "\\t", s); gsub(/\r/, "", s)
	return "\"" s "\""
}
function close_rec() {
	if (inrec) { recs = recs (nrec++ ? "," : "") "{" fields "}"; fields = ""; nf_ = 0 }
	inrec = 0
}

BEGIN { num = -1; recs = ""; nrec = 0; inrec = 0; fields = ""; nf_ = 0 }

{ line = $0; sub(/\r$/, "", line); sub(/^[ \t]+/, "", line) }

line ~ /\.NUM=[0-9]+$/ { num = substr(line, index(line, "=") + 1) + 0; next }

line ~ /\.[0-9]+:$/ { close_rec(); inrec = 1; next }

inrec && line ~ /^[A-Za-z_][A-Za-z0-9_.]*=/ {
	p = index(line, "=")
	k = substr(line, 1, p - 1); v = substr(line, p + 1)
	sub(/^.*\./, "", k)
	fields = fields (nf_++ ? "," : "") jstr(k) ":" jstr(v)
}

END {
	close_rec()
	if (num < 0) num = nrec
	printf "{\"table\":%s,\"num\":%d,\"records\":[%s]}\n", jstr(table), num, recs
}
