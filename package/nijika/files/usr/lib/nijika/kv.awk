# KEY=VALUE lines (flash all, nv getenv) -> JSON object {"KEY":"VALUE",...}
# Lines that are not KEY=VALUE (chain summary tables, banners) are skipped.
# Usage: flash all | awk -f kv.awk

function jstr(s) {
	gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); gsub(/\t/, "\\t", s); gsub(/\r/, "", s)
	return "\"" s "\""
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
