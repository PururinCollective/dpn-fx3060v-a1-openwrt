# SPDX-License-Identifier: GPL-2.0-only

# KEY=VALUE lines (flash all, nv getenv) -> JSON object {"KEY":"VALUE",...}
# Lines that are not KEY=VALUE (chain summary tables, banners) are skipped.
# Usage: flash all | awk -f kv.awk

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

BEGIN { n = 0; printf "{" }

/^[A-Za-z_][A-Za-z0-9_.]*=/ {
	p = index($0, "=")
	k = substr($0, 1, p - 1); v = substr($0, p + 1); sub(/\r$/, "", v)
	if (k in seen) next
	seen[k] = 1
	printf "%s%s:%s", (n++ ? "," : ""), jstr(k), jstr(v)
}

END { print "}" }
