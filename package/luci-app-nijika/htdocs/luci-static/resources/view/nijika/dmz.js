// SPDX-License-Identifier: Apache-2.0

'use strict';
'require view';
'require form';
'require uci';
'require nijika.common as nc';

/*
 * Network > DMZ: the stock GUI's Firewall > DMZ (formDMZ): DMZ_ENABLE,
 * DMZ_IP and DMZ_WAN (65535 = any WAN) of /etc/config/rtk. Save & Apply
 * writes them and applies them like the stock page
 * (restart_IPFilter_DMZ_MACFilter).
 */

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('rtk'),
			L.resolveDefault(nc.callMibGet([ 'LAN_IP_ADDR', 'LAN_SUBNET' ]), {})
		]);
	},

	render: function(data) {
		var lan = data[1] || {}, m, s, o;

		m = new form.Map('rtk', _('DMZ Configuration'),
			_('This page is used to configure the DMZ host, as the stock DMZ page. An incoming IPv4 connection that matches no port forwarding rule is sent to the DMZ host. The DMZ host is exposed to the Internet: only its own firewall protects it.'));

		s = m.section(form.NamedSection, 'mib', 'mib');

		o = s.option(form.Flag, 'DMZ_ENABLE', _('Enable DMZ'));
		o.rmempty = false;

		o = s.option(form.Value, 'DMZ_IP', _('DMZ host'), _('A LAN address, not the router\'s.'));
		o.datatype = 'ip4addr("nomask")';
		o.depends('DMZ_ENABLE', '1');
		o.validate = function(sid, v) {
			if (!v)
				return _('Required');
			if (v == lan.LAN_IP_ADDR)
				return _('That is the router\'s own address');
			return true;
		};

		o = s.option(form.ListValue, 'DMZ_WAN', _('WAN'));
		o.value('65535', _('Any'));
		uci.sections('rtk', 'ATM_VC_TBL').forEach(function(r, i) {
			if (r.ChannelMode != '0')
				o.value(String(r.ifIndex), nc.wanLabel(r, i));
		});
		o.depends('DMZ_ENABLE', '1');

		s.children.forEach(function(c) { c.retain = true; });

		return m.render();
	},

	handleSaveApply: function(ev, mode) {
		nc.reloadAfterApply(this, 'rtk');
		return this.super('handleSaveApply', [ ev, mode ]);
	}
});
