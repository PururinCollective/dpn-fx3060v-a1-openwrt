# shellcheck shell=ash
# NijikaWrt shared helpers (sourced by /usr/sbin/nijika, rpcd and ontd).

NIJIKA_LIB=/usr/lib/nijika
NIJIKA_SHARE=/usr/share/nijika
NIJIKA_RUNDIR=/tmp/nijika
RTK=/rtk
RTK_RUN=/usr/libexec/rtk/run
RTK_GLIBC=/usr/libexec/rtk/glibc

# --- vendor access ---------------------------------------------------------

vendor_up() {
	grep -q " $RTK/proc " /proc/mounts
}

rtk() {
	"$RTK_RUN" "$@"
}

# Stock tools that only need libc can run without the chroot (preinit,
# sysupgrade stage2). nv shares a lock file with the vendor side, so prefer
# the chroot when it is up.
rtk_tool() {
	local tool="$1"; shift
	if vendor_up; then
		"$RTK_RUN" "/bin/$tool" "$@"
	else
		"$RTK_GLIBC" "$RTK/bin/$tool" "$@"
	fi
}

diag() { rtk /bin/diag "$@" 2>/dev/null; }
omcicli() { rtk /bin/omcicli "$@" 2>/dev/null; }

# --- MIB (flash) -------------------------------------------------------------

# mib_get KEY -> value (empty if unset). Chain members (ATM_VC_TBL.0.vid)
# may be printed with or without the table prefix, accept both.
mib_get() {
	rtk /bin/flash get "$1" 2>/dev/null |
		sed -n -e "s/^[[:space:]]*$1=//p" -e "s/^[[:space:]]*${1##*.}=//p" | head -n 1
}

# mib_get_def KEY -> factory default value
mib_get_def() {
	rtk /bin/flash get_def "$1" 2>/dev/null | sed -n "s/^$1=//p" | head -n 1
}

# mib_set KEY VALUE (persistent)
mib_set() {
	rtk /bin/flash set "$1" "$2" >/dev/null 2>&1
}

# --- U-Boot environment via stock nv ----------------------------------------

nv_get() {
	rtk_tool nv getenv "$1" 2>/dev/null | sed -n "s/^$1=//p" | tr -d '\r' | head -n 1
}

nv_set() {
	if [ $# -ge 2 ]; then
		rtk_tool nv setenv "$1" "$2" >/dev/null 2>&1
	else
		rtk_tool nv setenv "$1" >/dev/null 2>&1
	fi
}

# --- banks ------------------------------------------------------------------

# Bank we are running from: U-Boot passes root=31:8 (bank 0) or 31:11 (bank 1).
running_bank() {
	case " $(cat /proc/cmdline) " in
		*" root=31:8 "*) echo 0 ;;
		*" root=31:11 "*) echo 1 ;;
		*) nv_get sw_active ;;
	esac
}

# ubi_vol_dev NAME -> /dev/ubi0_N
ubi_vol_dev() {
	local d
	for d in /sys/class/ubi/ubi0_*; do
		[ "$(cat "$d/name" 2>/dev/null)" = "$1" ] && {
			echo "/dev/${d##*/}"
			return 0
		}
	done
	return 1
}

# --- output helpers ---------------------------------------------------------

json_escape() {
	# stdin -> JSON string body (no surrounding quotes)
	awk 'BEGIN { ORS = "" } {
		gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "")
		if (NR > 1) printf "\\n"
		printf "%s", $0
	}'
}

die() {
	echo "nijika: $*" >&2
	exit 1
}

# hex_to_ascii 0x48575443 -> HWTC (non printable bytes become '.')
hex_to_ascii() {
	echo "$1" | awk '{
		h = tolower($0); sub(/^0x/, "", h); out = ""
		for (i = 1; i + 1 <= length(h); i += 2) {
			v = (index("0123456789abcdef", substr(h, i, 1)) - 1) * 16 + \
			    (index("0123456789abcdef", substr(h, i + 1, 1)) - 1)
			out = out ((v >= 32 && v < 127) ? sprintf("%c", v) : ".")
		}
		print out
	}'
}

format_uptime() {
	awk -v s="$1" 'BEGIN {
		s = int(s); d = int(s / 86400); h = int((s % 86400) / 3600); m = int((s % 3600) / 60)
		if (d > 0) printf "%dd %dh %dm\n", d, h, m
		else if (h > 0) printf "%dh %dm\n", h, m
		else printf "%dm\n", m
	}'
}
