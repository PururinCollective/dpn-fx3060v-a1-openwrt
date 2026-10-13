# Parse `omcicli mib get <class>` into JSON:
#   {"class":171,"name":"ExtVlanTagOperCfgData","instances":[
#      {"attrs":[["EntityId","0x101"],...],"raw":"..."}, ...],"truncated":false}
# Attributes are kept as ordered [key, value] pairs (keys can repeat, e.g.
# VLAN rule tables). Indented lines continue the previous attribute.
#
# Usage: omcicli mib get 171 | awk -v class=171 -f me.awk

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
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }

function flush_attr() {
	if (akey == "" && aval == "") return
	attrs = attrs (nattr++ ? "," : "") "[" jstr(akey) "," jstr(aval) "]"
	akey = ""; aval = ""
}
function flush_inst() {
	flush_attr()
	if (nattr == 0 && raw == "") return
	insts = insts (ninst++ ? "," : "") "{\"attrs\":[" attrs "],\"raw\":" jstr(raw) "}"
	attrs = ""; nattr = 0; raw = ""
}

BEGIN { inhdr = 0; inst = 0; name = ""; insts = ""; ninst = 0; attrs = ""; nattr = 0; raw = ""; akey = ""; aval = "" }

/^X{8,}[ \t\r]*$/ { inhdr = !inhdr; next }
inhdr { t = trim($0); if (t != "") name = t; next }

/^={8,}[ \t\r]*$/ {
	if (inst) { flush_inst(); inst = 0 } else { inst = 1 }
	next
}

{
	if (!inst) next
	line = $0; sub(/\r$/, "", line)
	raw = raw (raw == "" ? "" : "\n") line
	if (line ~ /^[ \t]/ || trim(line) == "") {
		t = trim(line)
		if (t != "") aval = aval (aval == "" ? "" : "\n") t
		next
	}
	flush_attr()
	p = index(line, ":")
	if (p) { akey = trim(substr(line, 1, p - 1)); aval = trim(substr(line, p + 1)) }
	else { akey = trim(line); aval = "" }
}

END {
	# an instance still open at the end: omcicli stopped reading early
	trunc = inst ? "true" : "false"
	if (inst) flush_inst()
	printf "{\"class\":%d,\"name\":%s,\"instances\":[%s],\"truncated\":%s}\n", class + 0, jstr(name), insts, trunc
}
