# Parse `omcicli mib get <class>` into JSON:
#   {"class":171,"name":"ExtVlanTagOperCfgData","instances":[
#      {"attrs":[["EntityId","0x101"],...],"raw":"..."}, ...]}
# Attributes are kept as ordered [key, value] pairs (keys can repeat, e.g.
# VLAN rule tables). Indented lines continue the previous attribute.
#
# Usage: omcicli mib get 171 | awk -v class=171 -f me.awk

function jstr(s) {
	gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); gsub(/\t/, "\\t", s)
	gsub(/\r/, "", s); gsub(/\n/, "\\n", s)
	return "\"" s "\""
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
	if (inst) flush_inst()
	printf "{\"class\":%d,\"name\":%s,\"instances\":[%s]}\n", class + 0, jstr(name), insts
}
