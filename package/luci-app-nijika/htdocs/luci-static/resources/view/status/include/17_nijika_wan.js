// SPDX-License-Identifier: Apache-2.0

'use strict';
'require baseclass';
'require nijika.common as nc';

/*
 * Status > Overview, WAN: the stock connections like the stock GUI's Device
 * Status table (rpcd wan_status): interface PON_<n>, VLAN, type (service),
 * protocol, address, gateway, state.
 */

var STATE = {
	up: [ 'ok', _('up') ], connecting: [ 'warn', _('connecting') ],
	down: [ 'bad', _('down') ], disabled: [ 'off', _('disabled') ]
};

return baseclass.extend({
	title: _('WAN'),

	load: function() {
		return nc.wanStatus();
	},

	render: function(wans) {
		wans = L.toArray(wans);
		if (!wans.length)
			return E('em', {}, _('No WAN connection in the stock configuration.'));

		var rows = wans.map(function(w) {
			var s = STATE[w.state] || [ 'off', w.state || '?' ];
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', 'data-title': _('Interface') }, [
					E('strong', {}, w.name), w.default_route ? E('small', { 'title': _('Default route') }, ' ★') : '',
					E('br'), E('small', { 'style': 'opacity:.6' }, w.ifname)
				]),
				E('td', { 'class': 'td', 'data-title': _('VLAN ID') }, w.vid || _('untagged')),
				E('td', { 'class': 'td', 'data-title': _('Type') }, nc.wanService(w)),
				E('td', { 'class': 'td', 'data-title': _('Protocol') }, nc.wanMode(w)),
				E('td', { 'class': 'td', 'data-title': _('IP Address') }, w.ChannelMode == '0' ? '-' : [
					w.ip4 ? (w.prefix4 && w.prefix4 != '32' ? '%s/%s'.format(w.ip4, w.prefix4) : w.ip4) : '-',
					w.ip6 ? E('br') : '', w.ip6 ? E('small', {}, w.ip6) : ''
				]),
				E('td', { 'class': 'td', 'data-title': _('Gateway') }, w.gw4 || '-'),
				E('td', { 'class': 'td', 'data-title': _('Status') }, E('span', { 'class': 'nijika-badge ' + s[0] }, s[1]))
			]);
		});

		return E([], [
			nc.style(),
			E('style', {}, '.nijika-badge.off{background:#888}'),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					_('Interface'), _('VLAN ID'), _('Type'), _('Protocol'), _('IP Address'), _('Gateway'), _('Status')
				].map(function(t) { return E('th', { 'class': 'th' }, t); }))
			].concat(rows))
		]);
	}
});
