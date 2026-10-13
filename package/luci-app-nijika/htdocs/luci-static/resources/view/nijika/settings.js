'use strict';
'require view';
'require form';
'require uci';

return view.extend({
	render: function() {
		var m, s, o;

		m = new form.Map('nijika', _('NijikaWrt Settings'),
			_('How OpenWrt and the stock Realtek vendor stack (the <code>/rtk</code> chroot) cooperate.'));

		s = m.section(form.NamedSection, 'vendor', 'vendor', _('Vendor stack'));

		o = s.option(form.ListValue, 'boa', _('Stock web server (boa)'),
			_('The stock daemons expect boa to be running. "Shim" only satisfies that; "Stock" runs the original D-Link web GUI on port 8080 for settings not covered by LuCI yet.'));
		o.value('shim', _('Shim (no web GUI)'));
		o.value('stock', _('Stock D-Link GUI on port 8080'));
		o.default = 'shim';

		o = s.option(form.Flag, 'console', _('Vendor boot output on console'),
			_('Show the stock boot messages on the serial console. When off they go to the system log (<code>logread -e rtk</code>). Applies on next boot.'));
		o.default = '1';

		o = s.option(form.Flag, 'inetd', _('Stock telnet (inetd)'),
			_('Telnet on port 23 into the stock shell. SSH (dropbear) is always provided by OpenWrt.'));
		o.default = '0';

		o = s.option(form.Flag, 'lan_mgmt', _('Keep LuCI/SSH reachable from LAN'),
			_('Adds accept rules for TCP 22 and 80 on the LAN bridge to the stock iptables ruleset.'));
		o.default = '1';

		o = s.option(form.Value, 'lan_ifname', _('LAN bridge'));
		o.default = 'br0';
		o.depends('lan_mgmt', '1');

		s = m.section(form.NamedSection, 'banner', 'banner', _('Login banner'));
		o = s.option(form.ListValue, 'animate', _('Animation'));
		o.value('ssh', _('SSH/telnet sessions only'));
		o.value('always', _('Always (slow on 115200 baud serial)'));
		o.value('never', _('Never'));
		o = s.option(form.ListValue, 'color', _('Colours'));
		o.value('auto', _('Auto-detect'));
		o.value('truecolor', _('24-bit truecolor'));
		o.value('256', _('256 colours'));
		o.value('16', _('16 colours'));
		o.value('none', _('Monochrome'));

		s = m.section(form.NamedSection, 'pon', 'pon', _('PON status'));
		o = s.option(form.Value, 'cache_ttl', _('Cache lifetime (s)'),
			_('PON/ONT status is read from the stock tools (diag, omcicli) only when LuCI, <code>nijika info</code> or the login banner asks for it, and reused for this many seconds. Nothing polls in the background.'));
		o.datatype = 'range(1,300)';
		o.default = '5';

		return m.render();
	}
});
