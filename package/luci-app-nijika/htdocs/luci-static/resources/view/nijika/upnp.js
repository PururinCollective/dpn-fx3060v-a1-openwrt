// SPDX-License-Identifier: Apache-2.0

'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require dom';
'require nijika.common as nc';

/*
 * Services > UPnP: the stock GUI's UPnP page (formUpnp): UPNP and
 * UPNP_EXT_ITF (ifIndex of the WAN connection miniupnpd serves, 65535 =
 * none) of /etc/config/rtk. Save & Apply writes them and applies them like
 * the stock page (restart_upnp). The table is the stock "UPnP Current Port
 * Forwarding Table": the PORT_FW_TBL records miniupnpd added (Dynamic=1,
 * configd's copy, rpcd portfw_get). /rtk/etc/miniupnpd.conf limits them to
 * ports 1024-65535 and to the requesting device's own address.
 */

var NO_WAN = '65535';

function ports(a, b) {
	if (!+a)
		return '-';
	return (+b && +b != +a) ? '%d-%d'.format(+a, +b) : String(+a);
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('rtk'),
			L.resolveDefault(nc.callPortfwGet(), {})
		]);
	},

	render: function(data) {
		var wans = [], def, m, s, o, list;

		/* routed connections only, as the stock list (a bridge has no NAT) */
		uci.sections('rtk', 'ATM_VC_TBL').forEach(function(r, i) {
			if (r.ChannelMode != '0')
				wans.push({ id: String(r.ifIndex), label: nc.wanLabel(r, i), internet: +r.applicationtype & 2 });
		});
		def = (wans.filter(function(w) { return w.internet; })[0] || wans[0] || { id: NO_WAN }).id;

		m = new form.Map('rtk', _('UPnP Configuration'),
			_('This page is used to configure UPnP. The system acts as a daemon when you enable it and select WAN interface (upstream) that will use UPnP.') + ' ' +
			_('A LAN device can open ports 1024-65535 only, and only to its own address.'));

		s = m.section(form.NamedSection, 'mib', 'mib');

		o = s.option(form.Flag, 'UPNP', _('UPnP'));
		o.rmempty = false;
		o.validate = function(sid, v) {
			return (v == '1' && !wans.length) ? _('There is no routed WAN connection for UPnP') : true;
		};

		o = s.option(form.ListValue, 'UPNP_EXT_ITF', _('WAN Interface'));
		wans.forEach(function(w) { o.value(w.id, w.label); });
		if (!wans.length)
			o.value(NO_WAN, _('None'));
		/* 65535 (none, the stock default) or a deleted connection: offer the
		 * Internet one, and write it even when left as shown */
		o.cfgvalue = function(sid) {
			var v = form.ListValue.prototype.cfgvalue.apply(this, arguments);
			return this.keylist.indexOf(String(v)) >= 0 ? v : def;
		};
		o.forcewrite = true;
		o.depends('UPNP', '1');
		o.retain = true;

		this.table = E('table', { 'class': 'table' });
		this.fillTable(data[1]);
		list = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('UPnP Current Port Forwarding Table')),
			this.table,
			E('div', { 'class': 'right' }, E('button', {
				'class': 'cbi-button cbi-button-action',
				'click': ui.createHandlerFn(this, 'handleRefresh')
			}, _('Refresh')))
		]);

		return m.render().then(function(node) { return E([], [ node, list ]); });
	},

	fillTable: function(res) {
		var rows = ((res && res.chain && res.chain.records) || []).filter(function(r) {
			return r.Dynamic == '1';
		}).map(function(r) {
			return E('tr', { 'class': 'tr' }, [ r.Comment || '-', r.IP, { 1: 'TCP', 2: 'UDP' }[r.Protocol] || 'TCP + UDP',
				ports(r.PortStart, r.PortEnd), ports(r.externalportStart, r.externalportEnd) ]
				.map(function(t) { return E('td', { 'class': 'td' }, t); }));
		});
		dom.content(this.table, [
			E('tr', { 'class': 'tr table-titles' }, [ _('Comment'), _('Local IP'), _('Protocol'), _('Local Port'), _('Remote Port') ]
				.map(function(t) { return E('th', { 'class': 'th' }, t); }))
		].concat(rows.length ? rows : E('tr', { 'class': 'tr placeholder' }, E('td', { 'class': 'td' }, E('em', {}, _('None'))))));
	},

	handleRefresh: function() {
		return L.resolveDefault(nc.callPortfwGet(), {}).then(L.bind(this.fillTable, this));
	},

	handleSaveApply: function(ev, mode) {
		nc.reloadAfterApply(this, 'rtk');
		return this.super('handleSaveApply', [ ev, mode ]);
	}
});
