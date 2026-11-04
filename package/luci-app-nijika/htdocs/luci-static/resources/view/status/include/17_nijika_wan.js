// SPDX-License-Identifier: Apache-2.0

'use strict';
'require baseclass';
'require nijika.common as nc';

/*
 * Status > Overview, WAN: the connections of the stock stack, one row each
 * (rpcd wan_status): connection, type and VLAN, IPv4 and IPv6, status, and the
 * traffic of the Linux interface (luci-rpc getNetworkDevices). OpenWrt's
 * Network card knows only the interfaces of netifd, and the stock stack runs
 * the WAN.
 */

var STATE = {
	up: [ '#2fbf71', _('up') ], connecting: [ '#f0a020', _('connecting') ],
	down: [ '#e5484d', _('down') ], disabled: [ 'rgba(127,127,127,.45)', _('disabled') ]
};

function dot(color) {
	return E('span', { 'style': 'display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:.45em;vertical-align:middle;background:' + color });
}

function cell(title, kids, style) {
	return E('td', { 'class': 'td left', 'data-title': title, 'style': style || null }, kids);
}

/* non-empty values, one per line */
function lines(values) {
	var out = [];
	values.filter(function(v) { return v != null && v !== ''; }).forEach(function(v, i) {
		if (i)
			out.push(E('br'));
		out.push(v);
	});
	return out.length ? out : [ '-' ];
}

return baseclass.extend({
	title: _('WAN'),

	load: function() {
		return Promise.all([ nc.wanStatus(), nc.netDevices() ]);
	},

	render: function(data) {
		var wans = L.toArray(data[0]), devs = data[1] || {};
		if (!wans.length)
			return E('em', {}, _('No WAN connection in the stock configuration.'));

		var titles = [ _('Connection'), _('Type'), 'IPv4', 'IPv6', _('Status'), _('Traffic') ];
		var rows = wans.map(function(w) {
			var s = STATE[w.state] || [ STATE.disabled[0], w.state || '?' ];
			var bridge = w.ChannelMode == '0';
			var stats = (devs[w.ifname] || {}).stats;

			return E('tr', { 'class': 'tr' }, [
				cell(titles[0], [
					dot(s[0]), E('strong', {}, w.name),
					w.default_route ? E('span', { 'class': 'label', 'style': 'margin-left:.5em', 'title': _('Default route') }, _('default')) : '',
					E('br'), E('small', { 'style': 'opacity:.7' }, w.ifname)
				]),
				cell(titles[1], lines([
					'%s, %s'.format(nc.wanMode(w), nc.wanService(w)),
					w.vid ? 'VLAN ' + w.vid : _('untagged')
				]), 'white-space:nowrap'),
				cell(titles[2], lines(bridge ? [ _('bridged') ] : [
					w.ip4 ? (w.prefix4 && w.prefix4 != '32' ? '%s/%s'.format(w.ip4, w.prefix4) : w.ip4) : null,
					w.gw4 ? _('gateway %s').format(w.gw4) : null
				])),
				cell(titles[3], lines([ bridge ? null : w.ip6 ])),
				cell(titles[4], [ s[1] ], 'white-space:nowrap'),
				cell(titles[5], lines(stats ? [
					'↓ %1024.1mB'.format(stats.rx_bytes || 0),
					'↑ %1024.1mB'.format(stats.tx_bytes || 0)
				] : []), 'white-space:nowrap')
			]);
		});

		return E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, titles.map(function(t) { return E('th', { 'class': 'th' }, t); }))
		].concat(rows));
	}
});
