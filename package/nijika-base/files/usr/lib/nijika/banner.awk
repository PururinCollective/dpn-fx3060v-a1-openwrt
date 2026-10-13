# NijikaWrt banner renderer: grey -> colour sweep, left to right, with a
# cyan -> blue -> purple gradient across the columns.
#
# stdin: one banner line per input line, with inline colour tags:
#   {grad} gradient by column (default)   {hi} accent cyan   {txt} light
#   {dim} muted grey   {lbl} white label   {ok} green   {warn} amber   {bad} red
# vars:  mode=tc|256|16|none  frames=N  delay="<sleep command>"  width=N
#
# Busybox awk compatible (no gawk extensions).

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }
function mixc(a, b, t) { return int(a + (b - a) * t + 0.5) }

# Gradient stops: cyan (0,220,255) -> blue (40,120,255) -> purple (175,90,255)
# Each block (logo rows before the first blank line, then the rest) gets the
# full gradient across its own horizontal extent.
function grad(x,    t, u, lo, hi) {
	lo = GMIN[GRP[CUR_ROW]]; hi = GMAX[GRP[CUR_ROW]]
	t = (hi > lo) ? clamp((x - lo) / (hi - lo), 0, 1) : 0
	if (t < 0.5) {
		u = t * 2
		GR = mixc(0, 40, u); GG = mixc(220, 120, u); GB = mixc(255, 255, u)
	} else {
		u = (t - 0.5) * 2
		GR = mixc(40, 175, u); GG = mixc(120, 90, u); GB = mixc(255, 255, u)
	}
}

function base(name, x) {
	if (name == "grad") { grad(x); BR = GR; BG = GG; BB = GB; return }
	if (name == "hi")   { BR = 0;   BG = 220; BB = 255; return }
	if (name == "txt")  { BR = 222; BG = 226; BB = 236; return }
	if (name == "dim")  { BR = 112; BG = 120; BB = 140; return }
	if (name == "lbl")  { BR = 245; BG = 245; BB = 255; return }
	if (name == "ok")   { BR = 80;  BG = 225; BB = 120; return }
	if (name == "warn") { BR = 255; BG = 190; BB = 60;  return }
	if (name == "bad")  { BR = 255; BG = 85;  BB = 85;  return }
	grad(x); BR = GR; BG = GG; BB = GB
}

# 16-colour fallback codes
function code16(name, x,    t) {
	if (name == "grad") {
		grad(x)
		return (GG > 165) ? "96" : ((GR < 108) ? "94" : "95")
	}
	if (name == "hi") return "96"
	if (name == "txt" || name == "lbl") return "97"
	if (name == "dim") return "90"
	if (name == "ok") return "92"
	if (name == "warn") return "93"
	if (name == "bad") return "91"
	return "37"
}

function sgr(r, g, b,    q) {
	if (mode == "tc") {
		q = 6
		r = int(r / q) * q; g = int(g / q) * q; b = int(b / q) * q
		return ESC "[38;2;" r ";" g ";" b "m"
	}
	# xterm 256-colour cube
	return ESC "[38;5;" (16 + 36 * int(r / 255 * 5 + 0.5) + 6 * int(g / 255 * 5 + 0.5) + int(b / 255 * 5 + 0.5)) "m"
}

BEGIN {
	ESC = "\033"
	if (frames < 1) frames = 1
	if (width < 1) width = 76
	GREYR = 86; GREYG = 92; GREYB = 106
	BAND = 14; SLANT = 2
	rows = 0; group = 0
}

{
	line = $0; cur = "grad"; n = 0; i = 1; L = length(line)
	while (i <= L) {
		c = substr(line, i, 1)
		if (c == "{") {
			j = index(substr(line, i), "}")
			if (j > 1) {
				tag = substr(line, i + 1, j - 2)
				if (tag ~ /^[a-z]+$/) { cur = tag; i += j; continue }
			}
		}
		n++; CH[rows, n] = c; CN[rows, n] = cur
		i++
	}
	LEN[rows] = n
	if (n == 0 && group == 0 && rows > 0) group = 1
	GRP[rows] = group
	for (k = 1; k <= n; k++) if (CH[rows, k] != " ") {
		if (!((group) in GMIN) || k - 1 < GMIN[group]) GMIN[group] = k - 1
		if (!((group) in GMAX) || k - 1 > GMAX[group]) GMAX[group] = k - 1
	}
	rows++
}

END {
	if (mode == "none") {
		for (r = 0; r < rows; r++) {
			s = ""
			for (x = 1; x <= LEN[r]; x++) s = s CH[r, x]
			print s
		}
		exit
	}

	span = width + SLANT * rows + 2 * BAND
	if (frames > 1) printf "%s", ESC "[?25l"

	for (f = 0; f < frames; f++) {
		head = (frames > 1) ? -BAND + span * f / (frames - 1) : 1e9
		if (f > 0) printf "%s", ESC "[" rows "A\r"

		for (r = 0; r < rows; r++) {
			CUR_ROW = r
			out = ""; last = ""
			for (x = 1; x <= LEN[r]; x++) {
				c = CH[r, x]
				if (c == " ") { out = out c; continue }
				t = clamp((head - (x - 1 + SLANT * r)) / BAND, 0, 1)
				if (mode == "16") {
					if (t < 0.5) code = ESC "[90m"
					else if (t < 0.8 && frames > 1) code = ESC "[97m"
					else code = ESC "[" code16(CN[r, x], x - 1) "m"
				} else {
					base(CN[r, x], x - 1)
					cr = mixc(GREYR, BR, t); cg = mixc(GREYG, BG, t); cb = mixc(GREYB, BB, t)
					if (t > 0 && t < 1) {
						g = (1 - (2 * t - 1 < 0 ? 1 - 2 * t : 2 * t - 1)) * 0.45
						cr = mixc(cr, 255, g); cg = mixc(cg, 255, g); cb = mixc(cb, 255, g)
					}
					code = sgr(cr, cg, cb)
				}
				if (code != last) { out = out code; last = code }
				out = out c
			}
			printf "%s%s[0m%s[K\n", out, ESC, ESC
		}
		fflush()
		if (f < frames - 1 && delay != "") system(delay)
	}

	if (frames > 1) printf "%s", ESC "[?25h"
	printf "%s[0m", ESC
}
