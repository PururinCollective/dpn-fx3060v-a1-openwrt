'use strict';
'require view';
'require form';
'require nijika.common as nc';

/*
 * LAN, as the stock GUI's Setup > LAN Interface Settings
 * (formTcpipLanSetup) and Services > DHCP (formDhcpd): router address,
 * secondary address, LAN ports, IGMP snooping, LAN <-> WiFi blocking, DHCP
 * server. Saved and applied like the stock pages (restart_lanip,
 * restart_dhcp, restart_ethernet, rtk_multicast_snooping, setup_wlan_block;
 * see docs/BOA.md).
 */

var PORTS = 4;
var KEYS = [
	'LAN_IP_ADDR', 'LAN_SUBNET', 'LAN_ENABLE_IP2', 'LAN_IP_ADDR2', 'LAN_SUBNET2',
	'MP_MODE', 'WLAN_BLOCK_ETH2WIR',
	'DHCP_MODE', 'LAN_DHCP_POOL_START', 'LAN_DHCP_POOL_END', 'LAN_DHCP_LEASE',
	'LAN_DHCP_GATEWAY', 'LAN_DHCP_DOMAIN'
];
for (var i = 0; i < PORTS; i++)
	KEYS.push('SW_PORT_TBL.%d.Enable'.format(i));

/* MP_MODE bit 2 (MP_IGMP_SHIFT): IGMP/MLD snooping */
var MP_IGMP = 4;

return view.extend({
	load: function() {
		return nc.callMibGet(KEYS);
	},

	render: function(v) {
		var m, s, o, self = this;

		this.orig = v || {};
		m = new form.JSONMap({ lan: Object.assign({}, this.orig) }, _('LAN'),
			_('The LAN side of the router. Changes apply right away, as on the stock GUI. After changing the router address, open LuCI at the new address.'));
		this.map = m;

		s = m.section(form.NamedSection, 'lan', 'lan');
		s.tab('lan', _('LAN'));
		s.tab('dhcp', _('DHCP server'));

		o = s.taboption('lan', form.Value, 'LAN_IP_ADDR', _('Router address'));
		o.datatype = 'ip4addr';
		o.rmempty = false;
		o = s.taboption('lan', form.Value, 'LAN_SUBNET', _('Netmask'));
		o.datatype = 'ip4addr';
		o.rmempty = false;

		o = s.taboption('lan', form.Flag, 'LAN_ENABLE_IP2', _('Secondary address'));
		o.rmempty = false;
		o = s.taboption('lan', form.Value, 'LAN_IP_ADDR2', _('Secondary router address'));
		o.datatype = 'ip4addr';
		o.depends('LAN_ENABLE_IP2', '1');
		o = s.taboption('lan', form.Value, 'LAN_SUBNET2', _('Secondary netmask'));
		o.datatype = 'ip4addr';
		o.depends('LAN_ENABLE_IP2', '1');

		/* SW_PORT_TBL.<n>.Enable: the dots stay out of the option names */
		for (var p = 0; p < PORTS; p++) {
			o = s.taboption('lan', form.Flag, '_port' + p, _('Port LAN %d').format(p + 1));
			o.rmempty = false;
			o.key = 'SW_PORT_TBL.%d.Enable'.format(p);
			o.cfgvalue = function() { return self.orig[this.key] == '0' ? '0' : '1'; };
			o.write = function(sid, val) { this.map.data.set('json', sid, this.key, val); };
		}

		o = s.taboption('lan', form.Flag, '_snoop', _('IGMP/MLD snooping'),
			_('Multicast (IPTV) only to the ports that asked for it.'));
		o.rmempty = false;
		o.key = 'MP_MODE';
		o.cfgvalue = function() { return ((+self.orig.MP_MODE || 0) & MP_IGMP) ? '1' : '0'; };
		o.write = function(sid, val) {
			var mp = +self.orig.MP_MODE || 0;
			this.map.data.set('json', sid, 'MP_MODE', String(val == '1' ? (mp | MP_IGMP) : (mp & ~MP_IGMP)));
		};

		o = s.taboption('lan', form.Flag, 'WLAN_BLOCK_ETH2WIR', _('Block LAN <-> WiFi'),
			_('Wired and wireless devices cannot reach each other.'));
		o.rmempty = false;

		o = s.taboption('dhcp', form.ListValue, 'DHCP_MODE', _('Mode'));
		o.value('2', _('Server'));
		o.value('0', _('Off'));
		if (this.orig.DHCP_MODE != null && !/^[02]$/.test(this.orig.DHCP_MODE))
			o.value(this.orig.DHCP_MODE, this.orig.DHCP_MODE == '1' ? _('Relay (set on the stock GUI)') : _('Other (%s)').format(this.orig.DHCP_MODE));
		o = s.taboption('dhcp', form.Value, 'LAN_DHCP_POOL_START', _('First address'));
		o.datatype = 'ip4addr';
		o.depends('DHCP_MODE', '2');
		o = s.taboption('dhcp', form.Value, 'LAN_DHCP_POOL_END', _('Last address'));
		o.datatype = 'ip4addr';
		o.depends('DHCP_MODE', '2');
		o = s.taboption('dhcp', form.Value, 'LAN_DHCP_LEASE', _('Lease time (s)'), _('-1 = infinite'));
		o.datatype = 'or(range(60,999999999),"-1")';
		o.depends('DHCP_MODE', '2');
		o = s.taboption('dhcp', form.Value, 'LAN_DHCP_GATEWAY', _('Gateway'), _('Usually the router address.'));
		o.datatype = 'ip4addr';
		o.depends('DHCP_MODE', '2');
		o = s.taboption('dhcp', form.Value, 'LAN_DHCP_DOMAIN', _('Domain'));
		o.datatype = 'hostname';
		o.depends('DHCP_MODE', '2');

		/* a hidden field keeps its value */
		s.children.forEach(function(c) { c.retain = true; });

		return m.render();
	},

	handleSave: function() {
		return nc.mibSave(this.map, 'lan', this.orig, KEYS, _('LAN settings saved.'));
	},

	handleSaveApply: function() {
		return this.handleSave();
	},

	handleReset: null
});
