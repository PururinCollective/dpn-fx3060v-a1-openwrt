# SPDX-License-Identifier: GPL-2.0-only

# shellcheck shell=ash
# NijikaWrt banner layout, shared by the login banner (live, colour,
# animation: /usr/libexec/nijika/banner + banner.awk) and the static
# /etc/banner (failsafe, dropbear; written by scripts/assemble.sh).
#
#   banner_layout [links-file]
#
# Prints the banner lines with renderer tags (see banner.awk): a line may
# start with {@logo}, {@tx} or {@rx} (what the animation does with it), and
# {name} switches the colour for the following characters.
#
# Variables in: release owrt kernel tagline model, and status_line (the PON
# line, already tagged; empty for the static banner).
#
# Grid: the two light rules are 75 columns wide; the logo and tagline block
# (56 columns) starts at column 8, centred over the version line; "ft.
# <model>" ends under the tagline's last letter.

BANNER_LOGO_INDENT=8

banner_layout() {
	local links="${1:-/usr/share/nijika/banner-links}" pad ft end
	pad=$(printf '%*s' "$BANNER_LOGO_INDENT" '')

	printf '{@logo}%s %s\n' "$pad" '_______ __ __ __ __           ________        __'
	printf '{@logo}%s%s\n' "$pad" '|    |  |__|__|__|  |--.---.-.|  |  |  |.----.|  |_'
	printf '{@logo}%s%s\n' "$pad" '|       |  |  |  |    <|  _  ||  |  |  ||   _||   _|'
	printf '{@logo}%s%s\n' "$pad" '|__|____|__|  |__|__|__|___._||________||__|  |____|'
	printf '{@logo}%s           |___|     {lbl}%s\n' "$pad" "$tagline"
	if [ -n "$model" ]; then
		ft="ft. $model"
		end=$((BANNER_LOGO_INDENT + 21 + ${#tagline}))
		printf '{@logo}%*s{dim}ft. {txt}%s\n' $((end - ${#ft})) '' "$model"
	fi
	echo ''
	echo '{@tx} <---------------------------------------------------------- {lbl}TX 1310 nm{grad} ---'
	printf '  {hi}%s{dim}  |  {txt}%s{dim}  |  {txt}Linux %s\n' "$release" "$owrt" "$kernel"
	[ -n "$status_line" ] && printf '%s\n' "$status_line"
	echo '{@rx} --- {lbl}RX 1490 nm{grad} ---------------------------------------------------------->'

	if [ -s "$links" ]; then
		echo ''
		# "Label|URL" per line, # comments
		while IFS='|' read -r l u; do
			case "$l" in ''|'#'*) continue ;; esac
			printf ' {dim}%-12s: {hi}%s\n' "$l" "$u"
		done < "$links"
	fi
}

# Tags removed: the plain text (static banner, monochrome terminals)
banner_plain() {
	sed -e 's/^{@[a-z]*}//' -e 's/{[a-z]*}//g'
}
