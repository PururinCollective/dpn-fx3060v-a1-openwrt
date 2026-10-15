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

		o = s.option(form.ListValue, 'boa', _('Stock D-Link web GUI (ports 8080, 443)'),
			_('The stock web server (boa) always runs, the stock stack needs it (it starts the VoIP configuration server, among others). This only decides who may open its GUI: the router itself (reach it with <code>ssh -L 8080:127.0.0.1:8080</code>) or the whole LAN.'));
		o.value('hidden', _('Router only (hidden)'));
		o.value('lan', _('Reachable from the LAN'));
		o.default = 'hidden';

		o = s.option(form.Flag, 'live_apply', _('Live apply'),
			_('Apply stock configuration changes (Quick Setup, MIB editor, <code>/etc/config/rtk</code>, SPI firewall) to the running stack the way the stock web GUI does, instead of waiting for a reboot. WAN, firewall, LAN, WiFi, GPON registration and VoIP are covered.'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Flag, 'console', _('Vendor boot output on console'),
			_('Show the stock boot messages on the serial console. When off they go to the system log (<code>logread -e rtk</code>). Applies on next boot.'));
		o.default = '1';

		o = s.option(form.ListValue, 'stock_log', _('Stock services in the system log'),
			_('Syslog messages of the stock services shown in <code>logread</code> / Status &gt; System Log, up to this level. The stock firmware keeps notice and up; info and debug include about a line a second from the VoIP stack. Applies on next boot.'));
		o.value('3', _('Errors'));
		o.value('4', _('Warnings'));
		o.value('5', _('Notices (stock default)'));
		o.value('6', _('Info'));
		o.value('7', _('Debug (everything)'));
		o.default = '5';

		o = s.option(form.Flag, 'inetd', _('Stock telnet (inetd)'),
			_('Telnet on port 23 into the stock shell. SSH (dropbear) is always provided by OpenWrt.'));
		o.default = '0';

		o = s.option(form.Flag, 'lan_mgmt', _('Keep LuCI/SSH reachable from LAN'),
			_('Adds accept rules for TCP 22 and 80 on the LAN bridge to the stock iptables ruleset.'));
		o.default = '1';

		o = s.option(form.Value, 'lan_ifname', _('LAN bridge'));
		o.default = 'br0';
		o.depends('lan_mgmt', '1');

		s = m.section(form.NamedSection, 'doh', 'doh', _('DNS over HTTPS'),
			_('The stock DNS server (dnsmasq) sends every lookup of the LAN and the router to a local DNS over HTTPS proxy. Only the ISP\'s own domains (voice/IMS, TR-069 management) still go to the ISP\'s DNS, so phone and remote management keep working.'));
		o = s.option(form.Flag, 'enabled', _('Enable'));
		o.default = '1';
		o.rmempty = false;
		o = s.option(form.Value, 'resolver_url', _('Resolver URL'), _('RFC 8484 endpoint.'));
		o.placeholder = 'https://b.hitoha.moe/dns-query';
		o.default = 'https://b.hitoha.moe/dns-query';
		o.validate = function(id, v) {
			return /^https:\/\/[^\s\/]+\/\S*$/.test(v) ? true : _('Expected https://host/path');
		};
		o.depends('enabled', '1');
		o = s.option(form.Value, 'bootstrap_dns', _('Bootstrap DNS'),
			_('Plain DNS servers, comma separated, used only to look up the resolver\'s host name.'));
		o.placeholder = '1.1.1.1,8.8.8.8';
		o.default = '1.1.1.1,8.8.8.8';
		o.depends('enabled', '1');

		s = m.section(form.NamedSection, 'firewall', 'firewall', _('Stock SPI firewall'),
			_('The <em>SPI Firewall</em> switches of the stock GUI (Firewall &gt; IPv4/IPv6 Port Filtering): the default action of the stock forwarding filter. <em>Off</em> allows new connections both ways, <em>On</em> drops new incoming ones (stock default; outgoing stays allowed). NijikaWrt writes them to the stock configuration at every boot; a change here is applied right away (with live apply on). The router\'s own services (LuCI, SSH, stock GUI) are guarded by separate rules either way. The stock configuration is shared with the stock firmware bank.'));
		o = s.option(form.ListValue, 'spi_ipv4', _('IPv4'),
			_('Unsolicited incoming IPv4 connections still need a port forward or DMZ (NAT).'));
		o.value('off', _('Off'));
		o.value('on', _('On (stock default)'));
		o.value('keep', _('Keep stock GUI value'));
		o.default = 'off';
		o = s.option(form.ListValue, 'spi_ipv6', _('IPv6'),
			_('IPv6 has no NAT: when off, every LAN device with a public IPv6 address is reachable from the internet and only its own firewall protects it.'));
		o.value('off', _('Off'));
		o.value('on', _('On (stock default)'));
		o.value('keep', _('Keep stock GUI value'));
		o.default = 'off';

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
