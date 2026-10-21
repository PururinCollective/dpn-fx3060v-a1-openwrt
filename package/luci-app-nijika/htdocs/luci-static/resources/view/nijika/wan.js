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
 * see docs/BOA.md). A changed channel mode also goes through rtk-apply
 * wan-mode (services that named the old interface, PPP unit). The service
 * (connection type) is tied to service dependencies in the stock stack, so
 * it is shown, not edited; a connection can be deleted (rtk-apply
 * wan-delete).
 *
 * Channel modes as the stock form stores them (boa retrieveVcRecord,
 * V1.1.2 0x46b5a8 / 0x46aae0 / 0x46b4a4):
 *   Bridged  ChannelMode 0, BridgeType 0 (Ethernet) / 1 (PPPoE)
 *   IPoE     ChannelMode 1, ChannelAddrType 0 (static)
 *   DHCP     ChannelMode 1, ChannelAddrType 1
 *   PPPoE    ChannelMode 2
 *   DS-Lite  ChannelMode 6, IPv6 only (IpProtocol 2), dslite_* (AFTR)
 *   6rd      ChannelMode 8, IpProtocol 3, AddrMode 8, Sixrd*
 * Routed modes have BridgeType 2 unless the connection also bridges.
 *
 * Ports (libmib setup_vlan_tagging_intf / the port mapping rules): itfGroup
 * binds LAN ports and SSIDs to the connection; a LAN port also in
 * vlanTagGrp is bound through <port>.<VID>, i.e. it carries this
 * connection's VLAN tagged instead of untagged. This page shows the two as
 * "Port mapping" (untagged) and "VLAN tagging" (tagged); a port is one or
 * the other per connection, and may be tagged on several connections (like
 * a managed switch trunk). WiFi has no VLAN tagging.
 *
 * Field encodings: SDK mib.h (CHANNEL_MODE_*, IPVER_*, IPV6_WAN_*,
 * M_DHCPv6_REQ_*, PPP_*), form_src_generic/fmwan.c.
 */

var callWanDelete = rpc.declare({
	object: 'nijika', method: 'wan_delete', params: [ 'index' ], expect: { '': {} }
});

/* itfGroup bits (stock PMAP_*: virt2user = LAN1..4, 4 SSIDs per radio) */
var PORT_BITS = 14, LAN_PORTS = 4, LAN_MASK = 0xf;

/* the stock "Channel Mode" select */
var MODES = [ [ '0', _('Bridged') ], [ '1', _('IPoE (static)') ], [ '9', _('DHCP') ], [ '2', 'PPPoE' ],
	[ '6', 'DS-Lite' ], [ '8', '6rd' ] ];
var M_ROUTED = /^(1|9|2|6|8)$/,		/* everything but bridged */
	M_NAT = /^(1|9|2|8)$/,		/* routed with an IPv4 address */
	M_DUAL = /^(1|9|2)$/,		/* IP version and IPv6 addressing selectable */
	M_STATIC4 = /^(1|8)$/;		/* fixed IPv4 address */

function rec(sid) {
	return uci.get('rtk', sid) || {};
}

function recIndex(sid) {
	return +String(sid).replace(/^.*_/, '');
}

/* ChannelMode (+ DHCP) -> value of the mode select */
function uiMode(r) {
	if (r.ChannelMode == '1')
		return r.ChannelAddrType == '1' ? '9' : '1';
	return String(r.ChannelMode || '0');
}

function bits(v, n) {
	var r = [];
	for (var b = 0; b < n; b++)
		if (v & (1 << b))
			r.push(String(b));
	return r;
}

function mask(list) {
	return L.toArray(list).reduce(function(a, b) { return a | (1 << +b); }, 0);
}

function sibling(o, name) {
	return o.section.children.filter(function(c) { return c.option == name; })[0];
}

/* value of a sibling field as it will be saved: the form while it is shown,
 * the stored value otherwise */
function current(o, sid, name) {
	var c = sibling(o, name);
	if (c && c.isActive(sid))
		return c.formvalue(sid);
	return c ? c.cfgvalue(sid) : uci.get('rtk', sid, name);
}

/* Port mapping rows: [ title, [ [ bit, name, hint ], ... ] ]; WiFi entries
 * show the configured SSID (main SSID, guest SSIDs 1-4) */
function portGroups(wifi) {
	var lan = [];
	for (var i = 0; i < LAN_PORTS; i++)
		lan.push([ String(i), _('LAN %d').format(i + 1), '' ]);
	var groups = [ [ _('LAN ports'), lan ] ];
	if (wifi)
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

/* Port mapping (untagged, LAN + WiFi) and VLAN tagging (LAN only): a LAN
 * port ticked in one is unticked in the other (o.peer). Both write
 * itfGroup and vlanTagGrp together (writePorts). */
var PortMap = form.Value.extend({
	renderWidget: function(section_id, option_index, cfgvalue) {
		var self = this;
		var node = new PortGrid(cfgvalue != null ? cfgvalue : [], portGroups(this.wifi), {
			id: this.cbid(section_id),
			disabled: this.readonly || this.map.readonly
		}).render();
		node.addEventListener('change', function(ev) {
			var peer = sibling(self, self.peer), other;
			if (!ev.target.checked || !peer || +ev.target.value >= LAN_PORTS)
				return;
			other = document.getElementById(peer.cbid(section_id));
			if (other)
				other.querySelectorAll('input').forEach(function(i) {
					if (i.value == ev.target.value)
						i.checked = false;
				});
		});
		return node;
	},

	write: function(sid) {
		writePorts(this, sid);
	},

	/* nothing ticked: LuCI treats [] as empty and would delete the option */
	remove: function(sid) {
		writePorts(this, sid);
	}
});

/* Connection carries only routed traffic (BridgeType 2): its ports belong
 * to it alone (stock check_itfGroup). */
function routedOnly(o, sid) {
	var m = current(o, sid, '_mode');
	if (m == '0')
		return false;
	if (m == '6' || m == '8')
		return true;
	return current(o, sid, '_hybrid') == '2';
}

function writePorts(o, sid) {
	var untagged = mask(current(o, sid, 'itfGroup')) & ((1 << PORT_BITS) - 1);
	var tagged = mask(current(o, sid, 'vlanTagGrp')) & LAN_MASK;
	var old = +uci.get('rtk', sid, 'itfGroup') || 0;

	untagged &= ~tagged;
	/* keep bits above the 14 known ones as they are */
	uci.set('rtk', sid, 'itfGroup', String((old & ~((1 << PORT_BITS) - 1)) | untagged | tagged));
	uci.set('rtk', sid, 'vlanTagGrp', String(tagged));

	/* stock check_itfGroup: an untagged port belongs to one connection when
	 * either of the two only routes; tagged memberships never collide */
	var mine = routedOnly(o, sid);
	uci.sections('rtk', 'ATM_VC_TBL').forEach(function(other) {
		var sid2 = other['.name'], g = +other.itfGroup || 0, vt = (+other.vlanTagGrp || 0) & LAN_MASK;
		var clash = untagged & g & ~vt;
		if (sid2 == sid || !clash || !(mine || other.BridgeType == '2'))
			return;
		uci.set('rtk', sid2, 'itfGroup', String(g & ~clash));
	});
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
			_('The WAN connections of the stock configuration, one per VLAN, as on the stock GUI\'s PON WAN page. Changes are written to the stock configuration and applied right away: the connection restarts with the new settings (a brief interruption). The service of a connection is fixed by the stock configuration.'));

		s = m.section(form.GridSection, 'ATM_VC_TBL', _('Connections'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;
		s.modaltitle = function(sid) { return nc.wanLabel(rec(sid), recIndex(sid)); };
		nc.modalSaveErrors(s);
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
		s.tab('ports', _('Ports'));

		/* list columns */
		o = s.option(form.DummyValue, '_name', _('Name'));
		o.cfgvalue = function(sid) { return nc.wanName(rec(sid), recIndex(sid)); };
		o = s.option(form.DummyValue, '_service', _('Service'));
		o.cfgvalue = function(sid) { return nc.wanService(rec(sid)); };
		o = s.option(form.DummyValue, '_type', _('Mode'));
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

		/* hidden copy the port fields test against */
		o = s.taboption('general', form.HiddenValue, 'applicationtype');
		o.modalonly = true;

		/* General */
		o = s.taboption('general', form.DummyValue, '_label', _('Connection'));
		o.modalonly = true;
		o.cfgvalue = function(sid) { return nc.wanLabel(rec(sid), recIndex(sid)); };

		o = s.taboption('general', form.Flag, 'ChannelStatus', _('Enable'));
		o.modalonly = true;
		o.rmempty = false;

		o = s.taboption('general', form.ListValue, '_mode', _('Channel mode'),
			_('Changing it restarts the connection with a new interface; port forwards and routes that named this connection are removed, as on the stock GUI.'));
		o.modalonly = true;
		MODES.forEach(function(md) { o.value(md[0], md[1]); });
		o.cfgvalue = function(sid) { return uiMode(rec(sid)); };
		/* what the stock page's script does on a mode change: MTU 1492 for
		 * PPPoE, 1500 otherwise (if not set by hand), NAT on for a routed
		 * mode, routed only after bridged */
		o.onchange = function(ev, sid, val) {
			var sec = this.section, w = function(n) { return sec.getUIElement(sid, n); }, el;
			this.last = this.last || {};
			var was = this.last[sid] || uiMode(rec(sid));
			this.last[sid] = val;
			if ((el = w('MTU')) != null) {
				if (val == '2' && el.getValue() == '1500')
					el.setValue('1492');
				else if (val != '2' && el.getValue() == '1492')
					el.setValue('1500');
			}
			if (M_NAT.test(val) && !M_NAT.test(was) && (el = w('NAPT')) != null)
				el.setValue('1');
			if (was == '0' && M_DUAL.test(val) && (el = w('_hybrid')) != null)
				el.setValue('2');
		};
		o.write = function(sid, val) {
			var r = rec(sid), was = uiMode(r);
			var set = function(k, v) { uci.set('rtk', sid, k, String(v)); };
			if (val == was)
				return;
			set('ChannelMode', val == '9' ? '1' : val);
			set('ChannelAddrType', val == '9' ? '1' : '0');
			if (val == '0' || val == '6')
				set('NAPT', '0');
			if (val == '6' || val == '8')
				set('BridgeType', '2');
			if (val == '6') {
				set('IpProtocol', '2');
				set('AddrMode', '0');
				set('dslite_enable', '1');
			} else if (r.dslite_enable == '1') {
				set('dslite_enable', '0');
			}
			if (val == '8') {
				set('IpProtocol', '3');
				set('AddrMode', '8');
			}
		};

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
		o.depends('_mode', '0');

		o = s.taboption('general', form.ListValue, '_hybrid', _('Also bridge'),
			_('The stock "Enable Bridge": the bound LAN ports also reach the provider directly on this VLAN, next to the router.'));
		o.modalonly = true;
		o.value('2', _('No (routed only)'));
		o.value('0', _('Bridged Ethernet'));
		o.value('1', _('PPPoE pass-through'));
		o.cfgvalue = function(sid) {
			var b = uci.get('rtk', sid, 'BridgeType');
			return (b == '0' || b == '1') ? b : '2';
		};
		o.write = function(sid, val) { uci.set('rtk', sid, 'BridgeType', val); };
		o.depends('_mode', M_DUAL);

		o = s.taboption('general', form.Flag, 'NAPT', _('NAT'));
		o.modalonly = true;
		o.rmempty = false;
		o.depends('_mode', M_NAT);
		o = s.taboption('general', form.Flag, 'DefaultGW', _('Default route'));
		o.modalonly = true;
		o.rmempty = false;
		o.depends('_mode', M_ROUTED);
		o = s.taboption('general', form.Flag, 'enableIGMP', _('IGMP proxy'));
		o.modalonly = true;
		o.rmempty = false;
		o.depends('_mode', M_NAT);
		o = s.taboption('general', form.Flag, 'enableMLD', _('MLD proxy'));
		o.modalonly = true;
		o.rmempty = false;
		o.depends('_mode', M_NAT);
		o = s.taboption('general', form.Flag, 'enableIpQos', _('QoS'));
		o.modalonly = true;
		o.rmempty = false;
		o = s.taboption('general', form.Value, 'MTU', _('MTU'), _('PPPoE: at most 1492.'));
		o.modalonly = true;
		o.datatype = 'range(576,1500)';
		o.validate = function(sid, v) {
			if (current(this, sid, '_mode') == '2' && +v > 1492)
				return _('PPPoE: at most 1492');
			return true;
		};
		/* TCP MSS follows (stock page: MSS <= MTU - 40, IPv6 MTU - 60) */
		o.write = function(sid, val) {
			uci.set('rtk', sid, 'MTU', val);
			uci.set('rtk', sid, 'TCPMSS', String(+val - 40));
			uci.set('rtk', sid, 'TCPMSS6', String(+val - 60));
		};

		/* PPPoE */
		o = s.taboption('ppp', form.Value, 'pppUser', _('Username'));
		o.modalonly = true;
		o.rmempty = false;
		o.depends('_mode', '2');
		o = s.taboption('ppp', form.Value, 'pppPasswd', _('Password'));
		o.modalonly = true;
		o.password = true;
		o.rmempty = false;
		o.depends('_mode', '2');
		o = s.taboption('ppp', form.ListValue, 'pppConnectType', _('Connection'));
		o.modalonly = true;
		o.value('0', _('Always on'));
		o.value('1', _('On demand'));
		o.value('2', _('Manual'));
		o.depends('_mode', '2');
		o = s.taboption('ppp', form.Value, 'pppIdleTime', _('Idle timeout (min)'));
		o.modalonly = true;
		o.datatype = 'uinteger';
		o.depends({ _mode: '2', pppConnectType: '1' });
		o = s.taboption('ppp', form.ListValue, 'pppAuth', _('Authentication'));
		o.modalonly = true;
		o.value('0', _('Auto'));
		o.value('1', 'PAP');
		o.value('2', 'CHAP');
		o.value('3', 'MS-CHAP');
		o.value('4', 'MS-CHAPv2');
		o.depends('_mode', '2');
		o = s.taboption('ppp', form.Value, 'pppACName', _('AC name'), _('Optional; empty = any.'));
		o.modalonly = true;
		o.depends('_mode', '2');
		o = s.taboption('ppp', form.Value, 'pppServiceName', _('Service name'), _('Optional; empty = any.'));
		o.modalonly = true;
		o.depends('_mode', '2');
		o = s.taboption('ppp', form.DummyValue, '_noppp', '');
		o.modalonly = true;
		o.cfgvalue = function() { return _('Not a PPPoE connection.'); };
		o.depends('_mode', /^[^2]$/);

		/* IPv4 */
		o = s.taboption('ipv4', form.Value, 'LocalIPAddr', _('IP address'));
		o.modalonly = true;
		o.datatype = 'ip4addr';
		o.depends('_mode', M_STATIC4);
		o = s.taboption('ipv4', form.Value, 'SubnetMask', _('Netmask'));
		o.modalonly = true;
		o.datatype = 'ip4addr';
		o.depends('_mode', M_STATIC4);
		o = s.taboption('ipv4', form.Value, 'RemoteIPAddr', _('Gateway'));
		o.modalonly = true;
		o.datatype = 'ip4addr';
		o.depends('_mode', M_STATIC4);
		o = s.taboption('ipv4', form.ListValue, 'DNSMode', _('DNS servers'));
		o.modalonly = true;
		o.value('1', _('From the ISP'));
		o.value('0', _('Manual'));
		o.depends('_mode', M_NAT);
		o = s.taboption('ipv4', form.Value, 'DNSV4IPAddr1', _('DNS server 1'));
		o.modalonly = true;
		o.datatype = 'ip4addr';
		o.depends({ _mode: M_NAT, DNSMode: '0' });
		o = s.taboption('ipv4', form.Value, 'DNSV4IPAddr2', _('DNS server 2'));
		o.modalonly = true;
		o.datatype = 'ip4addr';
		o.depends({ _mode: M_NAT, DNSMode: '0' });
		o = s.taboption('ipv4', form.DummyValue, '_bridged4', '');
		o.modalonly = true;
		o.cfgvalue = function() { return _('Bridged: the LAN devices get their addresses from the ISP.'); };
		o.depends('_mode', '0');
		o = s.taboption('ipv4', form.DummyValue, '_dslite4', '');
		o.modalonly = true;
		o.cfgvalue = function() { return _('DS-Lite: IPv4 is tunnelled over IPv6 to the provider\'s AFTR, which does the NAT.'); };
		o.depends('_mode', '6');

		/* IPv6 */
		o = s.taboption('ipv6', form.ListValue, 'IpProtocol', _('IP version'));
		o.modalonly = true;
		o.value('1', _('IPv4'));
		o.value('2', _('IPv6'));
		o.value('3', _('IPv4 and IPv6'));
		o.depends('_mode', M_DUAL);
		o = s.taboption('ipv6', form.ListValue, 'AddrMode', _('IPv6 address'));
		o.modalonly = true;
		o.value('1', _('SLAAC (router advertisement)'));
		o.value('16', _('DHCPv6'));
		o.value('2', _('Static'));
		o.depends({ _mode: M_DUAL, IpProtocol: /^[23]$/ });
		o = s.taboption('ipv6', form.Value, 'Ipv6Addr', _('IPv6 address'));
		o.modalonly = true;
		o.datatype = 'ip6addr';
		o.depends({ _mode: M_DUAL, IpProtocol: /^[23]$/, AddrMode: '2' });
		o = s.taboption('ipv6', form.Value, 'Ipv6AddrPrefixLen', _('Prefix length'));
		o.modalonly = true;
		o.datatype = 'range(1,128)';
		o.depends({ _mode: M_DUAL, IpProtocol: /^[23]$/, AddrMode: '2' });
		o = s.taboption('ipv6', form.Value, 'RemoteIpv6Addr', _('IPv6 gateway'));
		o.modalonly = true;
		o.datatype = 'ip6addr';
		o.depends({ _mode: M_DUAL, IpProtocol: /^[23]$/, AddrMode: '2' });
		o = s.taboption('ipv6', BitBoxes, 'Ipv6DhcpRequest', _('DHCPv6 requests'),
			_('IA_NA: an address for the router; IA_PD: a prefix for the LAN.'));
		o.modalonly = true;
		o.value('1', 'IA_NA');
		o.value('2', 'IA_PD');
		o.rmempty = false;
		/* neither is a valid setting (0, e.g. SLAAC only); not optional,
		 * LuCI refused to save the dialog of such a connection */
		o.optional = true;
		o.cfgvalue = function(sid) {
			var v = +uci.get('rtk', sid, 'Ipv6DhcpRequest') || 0;
			return [ '1', '2' ].filter(function(b) { return v & +b; });
		};
		o.write = function(sid, val) {
			uci.set('rtk', sid, 'Ipv6DhcpRequest', String(L.toArray(val).reduce(function(a, b) { return a | +b; }, 0)));
		};
		o.depends({ _mode: M_DUAL, IpProtocol: /^[23]$/ });
		o = s.taboption('ipv6', form.ListValue, 'dnsv6Mode', _('IPv6 DNS servers'));
		o.modalonly = true;
		o.value('1', _('From the ISP (DHCPv6)'));
		o.value('0', _('Manual'));
		o.depends({ _mode: M_DUAL, IpProtocol: /^[23]$/ });
		o = s.taboption('ipv6', form.Value, 'Ipv6Dns1', _('IPv6 DNS server 1'));
		o.modalonly = true;
		o.datatype = 'ip6addr';
		o.depends({ _mode: M_DUAL, IpProtocol: /^[23]$/, dnsv6Mode: '0' });
		o = s.taboption('ipv6', form.Value, 'Ipv6Dns2', _('IPv6 DNS server 2'));
		o.modalonly = true;
		o.datatype = 'ip6addr';
		o.depends({ _mode: M_DUAL, IpProtocol: /^[23]$/, dnsv6Mode: '0' });

		/* DS-Lite: the AFTR (tunnel end) from DHCPv6 or set by hand */
		o = s.taboption('ipv6', form.ListValue, 'dslite_aftr_mode', _('AFTR'));
		o.modalonly = true;
		o.value('0', _('From the ISP (DHCPv6)'));
		o.value('1', _('Manual'));
		o.depends('_mode', '6');
		o = s.taboption('ipv6', form.Value, 'dslite_aftr_hostname', _('AFTR address'), _('Host name or IPv6 address.'));
		o.modalonly = true;
		o.datatype = 'or(hostname,ip6addr)';
		o.depends({ _mode: '6', dslite_aftr_mode: '1' });

		/* 6rd */
		o = s.taboption('ipv6', form.ListValue, 'SixrdMode', _('6rd configuration'));
		o.modalonly = true;
		o.value('1', _('Auto (DHCP option 212)'));
		o.value('0', _('Manual'));
		o.depends('_mode', '8');
		o = s.taboption('ipv6', form.Value, 'SixrdBRv4IP', _('Border relay'), _('IPv4 address of the 6rd border relay.'));
		o.modalonly = true;
		o.datatype = 'ip4addr';
		o.depends({ _mode: '8', SixrdMode: '0' });
		o = s.taboption('ipv6', form.Value, 'SixrdIPv4MaskLen', _('IPv4 mask length'));
		o.modalonly = true;
		o.datatype = 'range(0,32)';
		o.depends({ _mode: '8', SixrdMode: '0' });
		o = s.taboption('ipv6', form.Value, 'SixrdPrefix', _('6rd prefix'));
		o.modalonly = true;
		o.datatype = 'ip6addr';
		o.depends({ _mode: '8', SixrdMode: '0' });
		o = s.taboption('ipv6', form.Value, 'SixrdPrefixLen', _('6rd prefix length'));
		o.modalonly = true;
		o.datatype = 'range(1,64)';
		o.depends({ _mode: '8', SixrdMode: '0' });

		o = s.taboption('ipv6', form.DummyValue, '_bridged6', '');
		o.modalonly = true;
		o.cfgvalue = function() { return _('Bridged: IPv6 is the LAN devices\' own business.'); };
		o.depends('_mode', '0');

		/* stock retrieveIPv6Record: the DHCPv6 client runs for DHCPv6
		 * addressing, for DNS from DHCPv6 and for a delegated prefix; with
		 * DS-Lite to learn the AFTR */
		o = s.taboption('ipv6', form.HiddenValue, 'Ipv6Dhcp');
		o.modalonly = true;
		o.formvalue = function(sid) {
			var self = this, get = function(name) { return current(self, sid, name); };
			var md = get('_mode');
			if (md == '6')
				return get('dslite_aftr_mode') == '1' ? '0' : '1';
			if (md == '8')
				return '0';
			if (md == '0' || !/^[23]$/.test(get('IpProtocol')))
				return uci.get('rtk', sid, 'Ipv6Dhcp');
			var req = L.toArray(get('Ipv6DhcpRequest')).reduce(function(a, b) { return a | +b; }, 0);
			return (get('AddrMode') == '16' || get('dnsv6Mode') == '1' || (req & 2)) ? '1' : '0';
		};

		/* Ports */
		o = s.taboption('ports', PortMap, 'itfGroup', _('Port mapping'),
			_('LAN ports and SSIDs bound to this connection, untagged. An untagged port belongs to one connection (unless both are bridged): binding it here removes it from the others.'));
		o.modalonly = true;
		o.rmempty = false;
		o.optional = true;
		o.wifi = true;
		o.peer = 'vlanTagGrp';
		o.cfgvalue = function(sid) {
			var g = +uci.get('rtk', sid, 'itfGroup') || 0, vt = (+uci.get('rtk', sid, 'vlanTagGrp') || 0) & LAN_MASK;
			return bits(g & ~vt, PORT_BITS);
		};
		o.depends('applicationtype', /^(2|3|4|5|6|7|1[0-5])$/);

		o = s.taboption('ports', PortMap, 'vlanTagGrp', _('VLAN tagging'),
			_('LAN ports that carry this connection\'s VLAN tagged, like a managed switch trunk: several bridged connections can share a port this way, next to one untagged connection. Mostly for bridged connections; WiFi has no VLAN tagging.'));
		o.modalonly = true;
		o.rmempty = false;
		o.optional = true;
		o.wifi = false;
		o.peer = 'itfGroup';
		o.cfgvalue = function(sid) {
			var g = +uci.get('rtk', sid, 'itfGroup') || 0, vt = +uci.get('rtk', sid, 'vlanTagGrp') || 0;
			return bits(g & vt & LAN_MASK, LAN_PORTS);
		};
		o.depends({ applicationtype: /^(2|3|4|5|6|7|1[0-5])$/, vlan: '1' });

		o = s.taboption('ports', form.DummyValue, '_noports', '');
		o.modalonly = true;
		o.cfgvalue = function() { return _('TR-069 and VoIP-only connections carry no LAN ports.'); };
		o.depends('applicationtype', /^(0|1|8|9)$/);

		/* A field hidden by its dependencies keeps its value (LuCI would
		 * delete it; the mirror would only restore it from flash). */
		s.children.forEach(function(c) { c.retain = true; });

		return m.render();
	},

	handleSaveApply: function(ev, mode) {
		nc.reloadAfterApply(this, 'rtk');
		return this.super('handleSaveApply', [ ev, mode ]);
	}
});
