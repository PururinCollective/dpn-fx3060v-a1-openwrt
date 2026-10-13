# `omcicli dump qmap` -> JSON
#   {"pq":[{"meid":"0x8000","qid":0,"policy":"WRR","pw":0,"tcid":0,"dp":0,
#           "cir":0,"pir":0,"used":1}],
#    "tcont":[{"tcid":0,"meid":"0x8000","alloc":263,"gems":1}],
#    "us":[{"flow":0,"gem":263,"pq":"0x8000"}],
#    "ds":[{"flow":0,"gem":2047,"pq":"0"}]}
# Sections are "===== PQ =====", "== T-Cont ==", "== used us flow ==",
# "== used ds Flow =="; rows are whitespace separated. Only queues in use
# (UsedCnt > 0) and T-CONTs with an Alloc-ID (not 255) are kept. CIR/PIR
# are printed in units of 8 kbit/s.
# Usage: omcicli dump qmap | awk -f qmap.awk

function q(s) { return "\"" s "\"" }
function add(sec, obj) { out[sec] = out[sec] (n[sec]++ ? "," : "") obj }

BEGIN { sec = "" }

{ sub(/\r$/, "") }

/^=+ *PQ *=+/            { sec = "pq"; next }
/^=+ *T-Cont *=+/        { sec = "tcont"; next }
/^=+ *used us flow *=+/  { sec = "us"; next }
/^=+ *used ds [Ff]low *=+/ { sec = "ds"; next }
/^[-[:space:]]*$/        { next }
$1 !~ /^(0x[0-9a-fA-F]+|[0-9]+)$/ { next }

sec == "pq" && NF >= 10 && $10 + 0 > 0 {
	add("pq", "{\"meid\":" q($1) ",\"qid\":" ($2 + 0) ",\"policy\":" q($3) ",\"pw\":" ($4 + 0) \
		",\"tcid\":" ($5 + 0) ",\"dp\":" ($6 + 0) ",\"cir\":" ($8 + 0) ",\"pir\":" ($9 + 0) \
		",\"used\":" ($10 + 0) "}")
}
sec == "tcont" && NF >= 4 && $3 + 0 != 255 {
	add("tcont", "{\"tcid\":" ($1 + 0) ",\"meid\":" q($2) ",\"alloc\":" ($3 + 0) ",\"gems\":" ($4 + 0) "}")
}
(sec == "us" || sec == "ds") && NF >= 3 {
	add(sec, "{\"flow\":" ($1 + 0) ",\"gem\":" ($2 + 0) ",\"pq\":" q($3) "}")
}

END {
	printf "{\"pq\":[%s],\"tcont\":[%s],\"us\":[%s],\"ds\":[%s]}\n", out["pq"], out["tcont"], out["us"], out["ds"]
}
