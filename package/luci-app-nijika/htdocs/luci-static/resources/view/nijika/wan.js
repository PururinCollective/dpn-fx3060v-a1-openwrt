'use strict';
'require view';
'require dom';
'require form';
'require uci';
'require ui';
'require rpc';
'require nijika.common as nc';

/*
 * PON WAN: the stock WAN connections (MIB chain ATM_VC_TBL), the stock GUI's
 * Setup > PON WAN, named PON_<n> after their VC index. Backed by
 * /etc/config/rtk (rtk.ATM_VC_TBL_<record>, kept by uci-mirror): Save &
 * Apply writes the changed fields with `flash set` and applies them like the
 * stock page does (connection down with the old settings, up with the new,
 * see docs/BOA.md). Connection type and service are tied to the record's
 * interface index and service dependencies in the stock stack, so they are
 * shown, not edited; a connection can be deleted (rtk-apply wan-delete).
 *
 * Field encodings: SDK mib.h (CHANNEL_MODE_*, IPVER_*, IPV6_WAN_*,
 * M_DHCPv6_REQ_*, PPP_*), form_src_generic/fmwan.c.
 */

var callWanDelete = rpc.declare({
	object: 'nijika', method: 'wan_delete', params: [ 'index' ], expect: { '': {} }
});

/* itfGroup bits (stock PMAP_*: virt2user = LAN1..4, 4 SSIDs per radio) */
var PORT_BITS = 14;

/* Port mapping rows: [ title, [ [ bit, name, hint ], ... ] ]; WiFi entries
 * show the configured SSID (main SSID, guest SSIDs 1-4) */
function portGroups() {
	var lan = [];
	for (var i = 0; i < 4; i++)
		lan.push([ String(i), _('LAN %d').format(i + 1), '' ]);
	var groups = [ [ _('LAN ports'), lan ] ];
	[ [ 'WLAN_MBSSIB_TBL', 4, _('5 GHz') ], [ 'WLAN1_MBSSIB_TBL', 9, _('2.4 GHz') ] ].forEach(function(r) {
		var items = [];
		for (var j = 0; j < 5; j++) {
			var ssid = uci.get('rtk', r[0] + '_' + j, 'ssid');
			var what = j ? _('guest %d').format(j) : _('main');
			items.push([ String(r[1] + j), ssid || what, ssid ? what : '' ]);
		}
		groups.push([ r[2], items ]);
	});
	return groups;
}

/* The port mapping as a grid: a row per LAN / radio, a column per port or
 * SSID. Value: the checked bit numbers. */
var PortGrid = ui.AbstractElement.extend({
	__init__: function(value, groups, options) {
		this.value = L.toArray(value);
		this.groups = groups;
		this.options = options;
	},

	render: function() {
		var cell = 'padding:.25em .75em .25em 0;vertical-align:top;white-space:nowrap';
		this.node = E('table', { 'id': this.options.id, 'style': 'border-collapse:collapse' },
			this.groups.map(L.bind(function(g) {
				return E('tr', [ E('th', { 'style': cell + ';text-align:left;font-weight:normal;opacity:.75' }, g[0]) ]
					.concat(g[1].map(L.bind(function(it) {
						return E('td', { 'style': cell }, E('label', { 'title': it[2] }, [
							E('input', {
								'type': 'checkbox', 'value': it[0],
								'checked': this.value.indexOf(it[0]) >= 0 ? '' : null,
								'disabled': this.options.disabled ? '' : null
							}), ' ', it[1],
							it[2] ? E('small', { 'style': 'display:block;margin-left:1.4em;opacity:.6' }, it[2]) : ''
						]));
					}, this))));
			}, this)));
		this.setUpdateEvents(this.node, 'click');
		this.setChangeEvents(this.node, 'change');
		dom.bindClassInstance(this.node, this);
		return this.node;
	},

	getValue: function() {
		return Array.prototype.map.call(this.node.querySelectorAll('input:checked'), function(i) { return i.value; });
	},

	setValue: function(value) {
		value = L.toArray(value);
		this.node.querySelectorAll('input').forEach(function(i) { i.checked = value.indexOf(i.value) >= 0; });
	}
});

var PortMap = form.Value.extend({
	renderWidget: function(section_id, option_index, cfgvalue) {
		return new PortGrid(cfgvalue != null ? cfgvalue : [], portGroups(), {
			id: this.cbid(section_id),
			disabled: this.readonly || this.map.readonly
		}).render();
	}
});

function rec(sid) {
	return uci.get('rtk', sid) || {};
}

function recIndex(sid) {
	return +String(sid).replace(/^.*_/, '');
}

/* 14 checkboxes for a bitmask option */
var BitBoxes = form.MultiValue.extend({
	renderWidget: function(section_id, option_index, cfgvalue) {
		var w = new ui.Select(L.toArray(cfgvalue != null ? cfgvalue : this.default), this.transformChoices(), {
			id: this.cbid(section_id),
			multiple: true,
			widget: 'checkbox',
			orientation: this.orientation || 'horizontal',
			optional: true,
			disabled: this.readonly || this.map.readonly
		});
		return w.render();
	}
});

return view.extend({
	load: function() {
		return uci.load('rtk');
	},

	render: function() {
		var m, s, o;

		m = new form.Map('rtk', _('PON WAN'),
			_('The WAN connections of the stock configuration, one per VLAN, as on the stock GUI\'s PON WAN page. Changes are written to the stock configuration and applied right away: the connection restarts with the new settings (a brief interruption). The connection type and service are fixed by the stock configuration.'));

		s = m.section(form.GridSection, 'ATM_VC_TBL', _('Connections'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;
		s.modaltitle = function(sid) { return nc.wanLabel(rec(sid), recIndex(sid)); };
		s.renderSectionAdd = function() { return E([]); };
		s.handleRemove = function(sid) {
			var label = nc.wanLabel(rec(sid), recIndex(sid));
			return new Promise(function(resolve) {
				ui.showModal(_('Delete %s').format(label), [
					E('p', _('The connection is removed from the stock configuration, which the stock firmware bank uses too. Its LAN ports and SSIDs go to the connection with the default route. This cannot be undone here: the stock GUI can add a connection again.')),
					E('div', { 'class': 'right' }, [
						E('button', { 'class': 'btn', 'click': function() { ui.hideModal(); resolve(); } }, _('Cancel')), ' ',
						E('button', { 'class': 'btn cbi-button-negative important', 'click': ui.createHandlerFn(this, function() {
							return callWanDelete(recIndex(sid)).then(function(r) {
								ui.hideModal();
								if (!r || r.error)
									ui.addNotification(null, E('p', _('Deleting %s failed: %s').format(label, (r && r.error) || '?')), 'danger');
								else
									ui.addNotification(null, E('p', _('%s deleted.').format(label)), 'info');
								window.setTimeout(function() { location.reload(); }, 1500);
								resolve();
							});
						}) }, _('Delete'))
					])
				]);
			});
		};

		s.tab('general', _('General'));
		s.tab('ppp', _('PPPoE'));
		s.tab('ipv4', _('IPv4'));
		s.tab('ipv6', _('IPv6'));
		s.tab('ports', _('Port mapping'));

		/* list columns */
		o = s.option(form.DummyValue, '_name', _('Name'));
		o.cfgvalue = function(sid) { return nc.wanName(rec(sid), recIndex(sid)); };
		o = s.option(form.DummyValue, '_service', _('Service'));
		o.cfgvalue = function(sid) { return nc.wanService(rec(sid)); };
		o = s.option(form.DummyValue, '_mode', _('Type'));
		o.cfgvalue = function(sid) { return nc.wanMode(rec(sid)); };
		o = s.option(form.DummyValue, '_vlan', _('VLAN'));
		o.cfgvalue = function(sid) {
			var r = rec(sid);
			if (r.vlan != '1')
				return _('untagged');
			return +r.vprio > 0 ? '%s (p%s)'.format(r.vid, nc.vprioText(r.vprio)) : String(r.vid);
		};
		o = s.option(form.DummyValue, '_state', _('Enabled'));
		o.cfgvalue = function(sid) { return rec(sid).ChannelStatus == '1' ? _('yes') : _('no'); };

		/* hidden copies the field dependencies below test against */
		o = s.taboption('general', form.HiddenValue, 'ChannelMode');
		o.modalonly = true;
		o = s.taboption('general', form.HiddenValue, 'applicationtype');
		o.modalonly = true;

		/* General */
		o = s.taboption('general', form.DummyValue, '_label', _('Connection'));
		o.modalonly = true;
		o.cfgvalue = function(sid) { return nc.wanLabel(rec(sid), recIndex(sid)); };

		o = s.taboption('general', form.Flag, 'ChannelStatus', _('Enable'));
		o.modalonly = true;
		o.rmempty = false;

		o = s.taboption('general', form.Flag, 'vlan', _('VLAN tagged'));
		o.modalonly = true;
		o.rmempty = false;
		o = s.taboption('general', form.Value, 'vid', _('VLAN ID'));
		o.modalonly = true;
		o.datatype = 'range(1,4094)';
		o.depends('vlan', '1');
		o = s.taboption('general', form.ListValue, 'vprio', _('802.1p priority'), _('- = no marking'));
		o.modalonly = true;
		nc.vprioValues(o);
		o.depends('vlan', '1');
		o = s.taboption('general', form.Value, 'mVid', _('Multicast VLAN'),
			_('VLAN of the IPTV multicast stream; 0 = none.'));
		o.modalonly = true;
		o.datatype = 'range(0,4094)';

		o = s.taboption('general', form.ListValue, 'BridgeType', _('Bridge type'));
		o.modalonly = true;
		o.value('0', _('Ethernet'));
		o.value('1', _('PPPoE pass-through'));
		o.depends('ChannelMode', '0');

		o = s.taboption('general', form.Flag, 'NAPT', _('NAT'));
		o.modalonly = true;
		o.rmempty = false;
		o.depends('ChannelMode', /^[^0]/);
		o = s.taboption('general', form.Flag, 'DefaultGW', _('Default route'));
		o.modalonly = true;
		o.rmempty = false;
		o.depends('ChannelMode', /^[^0]/);
		o = s.taboption('general', form.Flag, 'enableIGMP', _('IGMP proxy'));
		o.modalonly = true;
		o.rmempty = false;
		o = s.taboption('general', form.Flag, 'enableMLD', _('MLD proxy'));
		o.modalonly = true;
		o.rmempty = false;
		o = s.taboption('general', form.Flag, 'enableIpQos', _('QoS'));
		o.modalonly = true;
		o.rmempty = false;
		o = s.taboption('general', form.Value, 'MTU', _('MTU'));
		o.modalonly = true;
		o.datatype = 'range(576,1500)';

		/* PPPoE */
		o = s.taboption('ppp', form.Value, 'pppUser', _('Username'));
		o.modalonly = true;
		o.depends('ChannelMode', '2');
		o = s.taboption('ppp', form.Value, 'pppPasswd', _('Password'));
		o.modalonly = true;
		o.password = true;
		o.depends('ChannelMode', '2');
		o = s.taboption('ppp', form.ListValue, 'pppConnectType', _('Connection'));
		o.modalonly = true;
		o.value('0', _('Always on'));
		o.value('1', _('On demand'));
		o.value('2', _('Manual'));
		o.depends('ChannelMode', '2');
		o = s.taboption('ppp', form.Value, 'pppIdleTime', _('Idle timeout (min)'));
		o.modalonly = true;
		o.datatype = 'uinteger';
		o.depends({ ChannelMode: '2', pppConnectType: '1' });
		o = s.taboption('ppp', form.ListValue, 'pppAuth', _('Authentication'));
		o.modalonly = true;
		o.value('0', _('Auto'));
		o.value('1', 'PAP');
		o.value('2', 'CHAP');
		o.value('3', 'MS-CHAP');
		o.value('4', 'MS-CHAPv2');
		o.depends('ChannelMode', '2');
		o = s.taboption('ppp', form.Value, 'pppACName', _('AC name'), _('Optional; empty = any.'));
		o.modalonly = true;
		o.depends('ChannelMode', '2');
		o = s.taboption('ppp', form.Value, 'pppServiceName', _('Service name'), _('Optional; empty = any.'));
		o.modalonly = true;
		o.depends('ChannelMode', '2');
		o = s.taboption('ppp', form.DummyValue, '_noppp', '');
		o.modalonly = true;
		o.cfgvalue = function() { return _('Not a PPPoE connection.'); };
		o.depends('ChannelMode', /^[^2]/);

		/* IPv4 */
		o = s.taboption('ipv4', form.ListValue, 'ChannelAddrType', _('Address'));
		o.modalonly = true;
		o.value('1', _('DHCP'));
		o.value('0', _('Static'));
		o.depends('ChannelMode', '1');
		o = s.taboption('ipv4', form.Value, 'LocalIPAddr', _('IP address'));
		o.modalonly = true;
		o.datatype = 'ip4addr';
		o.depends({ ChannelMode: '1', ChannelAddrType: '0' });
		o = s.taboption('ipv4', form.Value, 'SubnetMask', _('Netmask'));
		o.modalonly = true;
		o.datatype = 'ip4addr';
		o.depends({ ChannelMode: '1', ChannelAddrType: '0' });
		o = s.taboption('ipv4', form.Value, 'RemoteIPAddr', _('Gateway'));
		o.modalonly = true;
		o.datatype = 'ip4addr';
		o.depends({ ChannelMode: '1', ChannelAddrType: '0' });
		o = s.taboption('ipv4', form.ListValue, 'DNSMode', _('DNS servers'));
		o.modalonly = true;
		o.value('1', _('From the ISP'));
		o.value('0', _('Manual'));
		o.depends('ChannelMode', /^[^0]/);
		o = s.taboption('ipv4', form.Value, 'DNSV4IPAddr1', _('DNS server 1'));
		o.modalonly = true;
		o.datatype = 'ip4addr';
		o.depends({ ChannelMode: /^[^0]/, DNSMode: '0' });
		o = s.taboption('ipv4', form.Value, 'DNSV4IPAddr2', _('DNS server 2'));
		o.modalonly = true;
		o.datatype = 'ip4addr';
		o.depends({ ChannelMode: /^[^0]/, DNSMode: '0' });
		o = s.taboption('ipv4', form.DummyValue, '_bridged4', '');
		o.modalonly = true;
		o.cfgvalue = function() { return _('Bridged: the LAN devices get their addresses from the ISP.'); };
		o.depends('ChannelMode', '0');

		/* IPv6 */
		o = s.taboption('ipv6', form.ListValue, 'IpProtocol', _('IP version'));
		o.modalonly = true;
		o.value('1', _('IPv4'));
		o.value('2', _('IPv6'));
		o.value('3', _('IPv4 and IPv6'));
		o = s.taboption('ipv6', form.ListValue, 'AddrMode', _('IPv6 address'));
		o.modalonly = true;
		o.value('1', _('SLAAC (router advertisement)'));
		o.value('16', _('DHCPv6'));
		o.value('2', _('Static'));
		o.depends({ ChannelMode: /^[^0]/, IpProtocol: /^[23]$/ });
		o = s.taboption('ipv6', form.Value, 'Ipv6Addr', _('IPv6 address'));
		o.modalonly = true;
		o.datatype = 'ip6addr';
		o.depends({ ChannelMode: /^[^0]/, IpProtocol: /^[23]$/, AddrMode: '2' });
		o = s.taboption('ipv6', form.Value, 'Ipv6AddrPrefixLen', _('Prefix length'));
		o.modalonly = true;
		o.datatype = 'range(1,128)';
		o.depends({ ChannelMode: /^[^0]/, IpProtocol: /^[23]$/, AddrMode: '2' });
		o = s.taboption('ipv6', form.Value, 'RemoteIpv6Addr', _('IPv6 gateway'));
		o.modalonly = true;
		o.datatype = 'ip6addr';
		o.depends({ ChannelMode: /^[^0]/, IpProtocol: /^[23]$/, AddrMode: '2' });
		o = s.taboption('ipv6', BitBoxes, 'Ipv6DhcpRequest', _('DHCPv6 requests'),
			_('IA_NA: an address for the router; IA_PD: a prefix for the LAN.'));
		o.modalonly = true;
		o.value('1', 'IA_NA');
		o.value('2', 'IA_PD');
		o.rmempty = false;
		o.cfgvalue = function(sid) {
			var v = +uci.get('rtk', sid, 'Ipv6DhcpRequest') || 0;
			return [ '1', '2' ].filter(function(b) { return v & +b; });
		};
		o.write = function(sid, val) {
			uci.set('rtk', sid, 'Ipv6DhcpRequest', String(L.toArray(val).reduce(function(a, b) { return a | +b; }, 0)));
		};
		o.depends({ ChannelMode: /^[^0]/, IpProtocol: /^[23]$/ });
		o = s.taboption('ipv6', form.ListValue, 'dnsv6Mode', _('IPv6 DNS servers'));
		o.modalonly = true;
		o.value('1', _('From the ISP (DHCPv6)'));
		o.value('0', _('Manual'));
		o.depends({ ChannelMode: /^[^0]/, IpProtocol: /^[23]$/ });
		o = s.taboption('ipv6', form.Value, 'Ipv6Dns1', _('IPv6 DNS server 1'));
		o.modalonly = true;
		o.datatype = 'ip6addr';
		o.depends({ ChannelMode: /^[^0]/, IpProtocol: /^[23]$/, dnsv6Mode: '0' });
		o = s.taboption('ipv6', form.Value, 'Ipv6Dns2', _('IPv6 DNS server 2'));
		o.modalonly = true;
		o.datatype = 'ip6addr';
		o.depends({ ChannelMode: /^[^0]/, IpProtocol: /^[23]$/, dnsv6Mode: '0' });
		/* stock retrieveIPv6Record: the DHCPv6 client runs for DHCPv6
		 * addressing, for DNS from DHCPv6 and for a delegated prefix */
		o = s.taboption('ipv6', form.HiddenValue, 'Ipv6Dhcp');
		o.modalonly = true;
		o.formvalue = function(sid) {
			var get = L.bind(function(name) {
				var opt = this.section.children.filter(function(c) { return c.option == name; })[0];
				return opt && opt.isActive(sid) ? opt.formvalue(sid) : uci.get('rtk', sid, name);
			}, this);
			if (get('ChannelMode') == '0' || !/^[23]$/.test(get('IpProtocol')))
				return uci.get('rtk', sid, 'Ipv6Dhcp');
			var req = L.toArray(get('Ipv6DhcpRequest')).reduce(function(a, b) { return a | +b; }, 0);
			return (get('AddrMode') == '16' || get('dnsv6Mode') == '1' || (req & 2)) ? '1' : '0';
		};

		/* Port mapping */
		o = s.taboption('ports', PortMap, 'itfGroup', _('Bound to'),
			_('LAN ports and SSIDs that use this connection. A port or SSID belongs to one connection: binding it here removes it from the others. TR-069 and VoIP-only connections carry no ports.'));
		o.modalonly = true;
		o.rmempty = false;
		o.cfgvalue = function(sid) {
			var v = +uci.get('rtk', sid, 'itfGroup') || 0, r = [];
			for (var b = 0; b < PORT_BITS; b++)
				if (v & (1 << b))
					r.push(String(b));
			return r;
		};
		o.write = function(sid, val) {
			var mask = L.toArray(val).reduce(function(a, b) { return a | (1 << +b); }, 0);
			var old = +uci.get('rtk', sid, 'itfGroup') || 0;
			/* keep bits above the 14 known ones as they are */
			uci.set('rtk', sid, 'itfGroup', String((old & ~((1 << PORT_BITS) - 1)) | mask));
			/* stock check_itfGroup: a port belongs to one connection */
			uci.sections('rtk', 'ATM_VC_TBL').forEach(function(other) {
				var sid2 = other['.name'], v2 = +other.itfGroup || 0;
				if (sid2 != sid && (v2 & mask))
					uci.set('rtk', sid2, 'itfGroup', String(v2 & ~mask));
			});
		};
		/* nothing ticked: LuCI treats [] as empty and would delete the option */
		o.optional = true;
		o.remove = function(sid) { this.write(sid, []); };
		o.depends('applicationtype', /^(2|3|4|5|6|7|1[0-5])$/);
		o = s.taboption('ports', form.DummyValue, '_noports', '');
		o.modalonly = true;
		o.cfgvalue = function() { return _('TR-069 and VoIP-only connections carry no LAN ports.'); };
		o.depends('applicationtype', /^(0|1|8|9)$/);

		/* A field hidden by its dependencies keeps its value (LuCI would
		 * delete it; the mirror would only restore it from flash). */
		s.children.forEach(function(c) { c.retain = true; });

		return m.render();
	}
});
