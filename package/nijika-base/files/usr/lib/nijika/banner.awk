# SPDX-License-Identifier: GPL-2.0-only

# NijikaWrt banner renderer.
#
# stdin: banner lines from banner-layout.sh. A line may start with a role:
#   {@logo}  swept from grey to colour, left to right (cyan -> blue -> purple)
#   {@tx}    the ONT's laser going out (1310 nm, upstream): bursts leaving left
#   {@rx}    the light coming in (1490 nm, downstream): a wave flowing right
#   (none)   static text
# and colour tags for the characters that follow:
#   {grad} gradient by column   {hi} accent cyan   {txt} light   {dim} muted
#   {lbl} white label   {ok} green   {warn} amber   {bad} red
# vars: mode=tc|256|16|none  frames=N (1: no animation)  delay="<sleep cmd>"
#       rxlit=0|1 txlit=0|1: that light exists (live reading above -35 dBm).
#       A rule is red only then and grey otherwise, animated or not, so the
#       colour tells the truth.
#
# The animation (frames of ~30 ms) follows GPON: the downstream light comes
# in first, one continuous broadcast (a wave from the left); the ONT may only
# send once it hears it, and then sends in bursts (leaving to the left, only
# with downstream light). Meanwhile the name lights up. Only lines that change
# are redrawn. Busybox awk compatible (no gawk extensions).

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }
function mixc(a, b, t) { return int(a + (b - a) * t + 0.5) }

# Gradient for {grad} logo text: cyan (0,220,255) -> blue (40,120,255) ->
# purple (175,90,255) across the logo block.
function grad(x,    t, u) {
	t = (GMAXX > GMINX) ? clamp((x - GMINX) / (GMAXX - GMINX), 0, 1) : 0
	if (t < 0.5) {
		u = t * 2; GR = mixc(0, 40, u); GG = mixc(220, 120, u); GB = 255
	} else {
		u = (t - 0.5) * 2; GR = mixc(40, 175, u); GG = mixc(120, 90, u); GB = 255
	}
}

# base colour of a tag at column x -> BR BG BB
function base(name, x) {
	if (name == "hi")   { BR = 0;   BG = 220; BB = 255; return }
	if (name == "txt")  { BR = 222; BG = 226; BB = 236; return }
	if (name == "dim")  { BR = 112; BG = 120; BB = 140; return }
	if (name == "lbl")  { BR = 245; BG = 245; BB = 255; return }
	if (name == "ok")   { BR = 80;  BG = 225; BB = 120; return }
	if (name == "warn") { BR = 255; BG = 190; BB = 60;  return }
	if (name == "bad")  { BR = 255; BG = 85;  BB = 85;  return }
	grad(x); BR = GR; BG = GG; BB = GB
}

function code16(name, x) {
	if (name == "grad") { grad(x); return (GG > 165) ? "96" : ((GR < 108) ? "94" : "95") }
	if (name == "hi") return "96"
	if (name == "txt" || name == "lbl") return "97"
	if (name == "dim") return "90"
	if (name == "ok") return "92"
	if (name == "warn") return "93"
	if (name == "bad") return "91"
	return "37"
}

# SGR for an RGB colour (bold: 1/0); always resets first so bold never leaks
function sgr(r, g, b, bold,    q) {
	if (mode == "tc") {
		q = 6; r = int(r / q) * q; g = int(g / q) * q; b = int(b / q) * q
		return ESC "[0;" (bold ? "1;" : "") "38;2;" r ";" g ";" b "m"
	}
	return ESC "[0;" (bold ? "1;" : "") "38;5;" (16 + 36 * int(r / 255 * 5 + 0.5) + 6 * int(g / 255 * 5 + 0.5) + int(b / 255 * 5 + 0.5)) "m"
}
function sgr16(n, bold) { return ESC "[0;" (bold ? "1;" : "") n "m" }

# a light's brightness step 0 (dark) .. 5 (hot): red with light, grey without
function light(step, lit, bold) {
	if (mode == "16") return sgr16(lit ? L16[step] : U16[step], bold)
	if (lit) return sgr(LR[step], LG[step], LB[step], bold)
	return sgr(UR[step], UG[step], UB[step], bold)
}
function hot() { return (mode == "16") ? sgr16("97", 1) : sgr(255, 250, 245, 1) }
function dark() { return (mode == "16") ? sgr16("90", 0) : sgr(58, 60, 68, 0) }
function label() { return (mode == "16") ? sgr16("97", 0) : sgr(245, 245, 255, 0) }

# ---- rows ------------------------------------------------------------------

# static text in its final colours
function row_static(r,    x, c, code, out, last, key) {
	out = ""; last = ""
	for (x = 1; x <= LEN[r]; x++) {
		c = CH[r, x]
		if (c == " ") { out = out c; continue }
		key = (CN[r, x] == "grad") ? "grad" SUBSEP x : CN[r, x]
		if (key in SCK) code = SCK[key]
		else {
			if (mode == "16") code = sgr16(code16(CN[r, x], x - 1), 0)
			else { base(CN[r, x], x - 1); code = sgr(BR, BG, BB, 0) }
			SCK[key] = code
		}
		if (code != last) { out = out code; last = code }
		out = out c
	}
	return out
}

# Colour codes are computed once (prep): per logo cell its grey, four sweep
# steps (with the glint) and final code; per light its palette. A frame then
# only looks codes up: busybox awk on the RTL9607DQ spends ~100 us on a cell
# whose colour is blended per frame.
function prep(    r, x, lv, t, g, cr, cg, cb, s, code, last, pf, key) {
	for (s = 0; s <= 5; s++) { RXP[s] = light(s, RXLIT, 0); TXP[s] = light(s, TXLIT, 0) }
	RXH = light(4, RXLIT, 1); TXH = light(4, TXLIT, 1)
	HOTC = hot(); DARKC = dark(); LBLC = label()
	GREYC = (mode == "16") ? sgr16("90", 0) : sgr(GREYR, GREYG, GREYB, 0)
	for (r = 0; r < rows; r++) {
		if (ROLE[r] != "logo") continue
		for (x = 1; x <= LEN[r]; x++) {
			if (CH[r, x] == " ") continue
			X0[r, x] = x - 1 + SLANT * (r - LOGO0)
			key = CN[r, x] SUBSEP x
			if (key in LCK) { for (lv = 0; lv <= 5; lv++) LC[r, x, lv] = LCK[key, lv]; continue }
			LCK[key] = 1
			for (lv = 0; lv <= 5; lv++) {
				t = lv / 5
				if (mode == "16") {
					if (lv < 3) LC[r, x, lv] = sgr16("90", 0)
					else if (lv < 5) LC[r, x, lv] = sgr16("97", 1)
					else LC[r, x, lv] = sgr16(code16(CN[r, x], x - 1), 0)
					continue
				}

				base(CN[r, x], x - 1)
				cr = mixc(GREYR, BR, t); cg = mixc(GREYG, BG, t); cb = mixc(GREYB, BB, t)
				if (lv > 0 && lv < 5) {	# the glint at the band's middle
					g = (1 - (2 * t - 1 < 0 ? 1 - 2 * t : 2 * t - 1)) * 0.5
					cr = mixc(cr, 255, g); cg = mixc(cg, 255, g); cb = mixc(cb, 255, g)
				}
				LC[r, x, lv] = sgr(cr, cg, cb, 0)
			}
			for (lv = 0; lv <= 5; lv++) LCK[key, lv] = LC[r, x, lv]
		}
		# PFX[r, k]: cells 1..k fully lit (built once, a frame reuses them)
		pf = ""; last = ""; PFX[r, 0] = ""
		for (x = 1; x <= LEN[r]; x++) {
			if (CH[r, x] != " ") { code = LC[r, x, 5]; if (code != last) { pf = pf code; last = code } }
			pf = pf CH[r, x]; PFX[r, x] = pf
		}
	}
}

# a logo row with the sweep's head at column `head` (1e9: all lit, -1e9:
# grey): the lit prefix (precomputed), the band (cells computed), the grey
# rest (one code and the plain text)
function row_logo(r, head,    n, sh, a, b, x, c, d, code, out, last) {
	n = LEN[r]; sh = head - SLANT * (r - LOGO0)
	a = int(sh - BAND + 1); if (a < 0) a = 0; if (a > n) a = n		# cells 1..a lit
	b = int(sh + 1); if (b < sh + 1) b++; if (b < a + 1) b = a + 1; if (b > n + 1) b = n + 1	# b..n grey
	out = PFX[r, a]; last = ""
	for (x = a + 1; x < b; x++) {
		c = substr(TXT[r], x, 1)
		if (c == " ") { out = out c; continue }
		d = sh - (x - 1)
		code = LC[r, x, (d <= 0) ? 0 : ((d >= BAND) ? 5 : int(d * 4 / BAND) + 1)]
		if (code != last) { out = out code; last = code }
		out = out c
	}
	if (b <= n) out = out GREYC substr(TXT[r], b)
	return out
}

# the settled rule: dashes in step 3, the direction head one step hotter and
# bold, the label white; dark (lit < 0): everything dim but the label
function row_rule_final(r, lit,    x, c, t, code, out, last, hc, dc) {
	out = ""; last = ""; t = TXT[r]
	if (lit < 0) { hc = DARKC; dc = DARKC }
	else if (ROLE[r] == "rx") { hc = RXH; dc = RXP[3] }
	else { hc = TXH; dc = TXP[3] }
	for (x = 1; x <= LEN[r]; x++) {
		c = substr(t, x, 1)
		if (c == " ") { out = out c; continue }
		if (substr(LBL[r], x, 1) == "L") code = LBLC
		else if (x == HEAD[r]) code = hc
		else code = dc
		if (code != last) { out = out code; last = code }
		out = out c
	}
	return out
}

# IN at frame f: the wave's front 5 columns a frame from the left; behind it
# a brightness pattern travelling right ('=' on the brightest step) with
# amplitude a10/10; ahead of it the dark rule; the front a white-hot '>'.
function row_rx(r, f, a10,    x, c, t, lm, front, lv, code, out, last, ph, hd) {
	out = ""; last = ""; t = TXT[r]; lm = LBL[r]; hd = HEAD[r]
	front = FIRST[r] + 5 * f; ph = 1200 - 2 * f
	for (x = 1; x <= LEN[r]; x++) {
		c = substr(t, x, 1)
		if (c == " ") { out = out c; continue }
		if (substr(lm, x, 1) == "L") code = LBLC
		else if (x > front) code = DARKC
		else if (x == front && x < hd) { code = HOTC; c = ">" }
		else if (x == hd) code = RXH
		else {
			lv = 3 + int(a10 * (WAVE[(x + ph) % 10] - 3) / 10)
			code = RXP[lv]
			if (lv == 5) c = "="
		}
		if (code != last) { out = out code; last = code }
		out = out c
	}
	return out
}

# OUT at frame f: bursts leave the right end at frames TXS[], 6 columns a
# frame to the left, each a white-hot '<' head, a hot '===' body and a
# cooling tail; behind the first burst the rule keeps a dark glow.
function row_tx(r, f,    x, c, t, lm, k, d, h0, code, out, last, done, nb, H, n) {
	out = ""; last = ""; t = TXT[r]; lm = LBL[r]; n = LEN[r]
	h0 = n - 6 * (f - TXS[1])
	nb = 0
	for (k = 1; k <= NTXS; k++) if (f >= TXS[k]) H[++nb] = n - 6 * (f - TXS[k])
	for (x = 1; x <= n; x++) {
		c = substr(t, x, 1)
		if (c == " ") { out = out c; continue }
		if (substr(lm, x, 1) == "L") code = LBLC
		else {
			done = 0
			for (k = 1; k <= nb; k++) {
				d = x - H[k]
				if (d == 0) { code = HOTC; c = "<"; done = 1; break }
				if (d > 0 && d <= 8) { code = TXP[TAIL[d]]; if (d <= 3) c = "="; done = 1; break }
			}
			if (!done) code = (x > h0) ? TXP[1] : DARKC
		}
		if (code != last) { out = out code; last = code }
		out = out c
	}
	return out
}

function emit(r, s) { return s ESC "[0m" ESC "[K" }

# ---- input -----------------------------------------------------------------

BEGIN {
	ESC = "\033"
	if (frames < 1) frames = 1
	RXLIT = (rxlit == 1) ? 1 : 0
	TXLIT = (txlit == 1) ? 1 : 0
	GREYR = 86; GREYG = 92; GREYB = 106
	BAND = 12; SLANT = 2
	split("70 115 165 215 250 255", LR, " "); split("8 18 30 50 80 150", LG, " "); split("8 18 30 50 80 140", LB, " ")
	split("44 62 84 118 160 215", UR, " "); split("46 64 88 122 164 218", UG, " "); split("52 72 98 134 176 228", UB, " ")
	split("31 31 31 31 91 91", L16, " "); split("90 90 90 90 37 37", U16, " ")
	for (i = 0; i <= 5; i++) { LR[i] = LR[i + 1]; LG[i] = LG[i + 1]; LB[i] = LB[i + 1]; UR[i] = UR[i + 1]; UG[i] = UG[i + 1]; UB[i] = UB[i + 1]; L16[i] = L16[i + 1]; U16[i] = U16[i + 1] }
	split("1 2 3 4 5 5 4 3 2 1", W1, " "); for (i = 0; i < 10; i++) WAVE[i] = W1[i + 1]
	split("5 5 5 4 4 3 2 1", TAIL, " ")
	NTXS = split("15 18 21", TXS, " ")
	rows = 0; LOGO0 = -1; GMINX = 1e9; GMAXX = -1
}

{
	line = $0; role = ""
	if (substr(line, 1, 2) == "{@") {
		j = index(line, "}"); role = substr(line, 3, j - 3); line = substr(line, j + 1)
	}
	ROLE[rows] = role
	if (role == "logo" && LOGO0 < 0) LOGO0 = rows
	cur = "grad"; n = 0; i = 1; L = length(line)
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
		txt = txt c; lm = lm ((cur == "lbl") ? "L" : ".")
		if (c != " " && role == "logo") { if (n - 1 < GMINX) GMINX = n - 1; if (n - 1 > GMAXX) GMAXX = n - 1 }
		i++
	}
	LEN[rows] = n; TXT[rows] = txt; LBL[rows] = lm; txt = ""; lm = ""
	# the rule's direction head ('<' first or '>' last) and first drawn column
	FIRST[rows] = 0; HEAD[rows] = 0
	for (k = 1; k <= n; k++) if (CH[rows, k] != " ") { FIRST[rows] = k; break }
	if (role == "tx") HEAD[rows] = FIRST[rows]
	if (role == "rx") HEAD[rows] = n
	rows++
}

# ---- output ----------------------------------------------------------------

END {
	if (mode == "none") {
		for (r = 0; r < rows; r++) {
			s = ""; for (x = 1; x <= LEN[r]; x++) s = s CH[r, x]
			print s
		}
		exit
	}

	prep()

	if (frames == 1) {
		for (r = 0; r < rows; r++) {
			if (ROLE[r] == "logo") s = row_logo(r, 1e9)
			else if (ROLE[r] == "tx") s = row_rule_final(r, TXLIT)
			else if (ROLE[r] == "rx") s = row_rule_final(r, RXLIT)
			else s = row_static(r)
			print emit(r, s)
		}
		printf "%s", ESC "[0m"
		exit
	}

	# Frame plan (F frames): the downstream wave from frame 0 (front 5 columns
	# a frame, its pattern fading over the last 6 frames); bursts from frame 15
	# (when the wave has arrived), only with downstream light; the name lit by
	# a band from frame 3 to frame F-6. The last frame settles every rule.
	F = frames; LS = 3; LE = F - 6
	span = (GMAXX - GMINX + 1) + SLANT * 5 + 2 * BAND + GMINX
	printf "%s", ESC "[?25l"
	for (r = 0; r < rows; r++) {
		if (ROLE[r] == "logo") s = row_logo(r, -1e9)
		else if (ROLE[r] == "tx" || ROLE[r] == "rx") s = row_rule_final(r, -1)
		else s = row_static(r)
		print emit(r, s)
	}
	fflush()

	for (f = 1; f < F; f++) {
		if (delay != "") system(delay)
		o = ""; cur = rows
		for (r = 0; r < rows; r++) {
			s = ""
			if (ROLE[r] == "logo" && f >= LS && f <= LE + 1) {
				head = (f > LE) ? 1e9 : -BAND + span * (f - LS) / (LE - LS)
				s = row_logo(r, head)
			} else if (ROLE[r] == "rx") {
				if (f == F - 1) s = row_rule_final(r, RXLIT)
				else s = row_rx(r, f, (f < F - 7) ? 10 : int(10 * (F - 1 - f) / 6))
			} else if (ROLE[r] == "tx" && f >= TXS[1]) {
				if (f == F - 1) s = row_rule_final(r, TXLIT)
				else if (RXLIT) s = row_tx(r, f)
				else continue
			} else continue
			if (cur > r) o = o ESC "[" (cur - r) "A"
			else if (cur < r) o = o ESC "[" (r - cur) "B"
			o = o "\r" emit(r, s) "\n"
			cur = r + 1
		}
		if (cur < rows) o = o ESC "[" (rows - cur) "B"
		printf "%s", o
		fflush()
	}
	printf "%s", ESC "[?25h" ESC "[0m"
}
