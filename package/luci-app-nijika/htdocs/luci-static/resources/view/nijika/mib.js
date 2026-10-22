// SPDX-License-Identifier: Apache-2.0

'use strict';
'require view';
'require dom';
'require ui';
'require nijika.common as nc';

/*
 * Browser/editor for the stock Realtek configuration database (MIB):
 * scalar values (`flash all`) and chain tables (`flash get <TBL>`).
 * Writes use `flash set` (configd commits them to flash); keys a stock web form
 * applies live (WAN, firewall, LAN, WiFi, GPON) are applied the same way,
 * the rest after a reboot.
 */

function editValue(key, value, done) {
	var input = E('input', { 'class': 'cbi-input-text', 'style': 'width:100%', 'value': value });
	ui.showModal(_('Edit %s').format(key), [
		E('p', { 'class': 'nijika-hint' }, _('Current: %s').format(value === '' ? _('(empty)') : value)),
		input,
		E('div', { 'class': 'right', 'style': 'margin-top:1em' }, [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
			E('button', { 'class': 'btn cbi-button-positive important', 'click': ui.createHandlerFn(this, function() {
				var nv = input.value;
				return nc.callMibSet([ [ key, nv ] ]).then(function(r) {
					ui.hideModal();
					if (!r || r.error || (r.failed && r.failed.length))
						return ui.addNotification(null, E('p', _('Setting %s failed').format(key)), 'danger');
					ui.addNotification(null, E('p', nc.applyText(r, _('%s saved.').format(key))), 'info');
					done(nv);
				});
			}) }, _('Save'))
		])
	]);
	input.focus();
}

return view.extend({
	load: function() {
		return nc.callMibAll();
	},

	renderScalars: function(values, filter) {
		var f = (filter || '').toLowerCase(), self = this;
		var keys = Object.keys(values).sort().filter(function(k) {
			return !f || k.toLowerCase().indexOf(f) >= 0 || String(values[k]).toLowerCase().indexOf(f) >= 0;
		});
		var shown = keys.slice(0, 400);
		var rows = shown.map(function(k) {
			var cell = E('td', { 'class': 'td left nijika-mono', 'style': 'word-break:break-all' }, values[k]);
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left nijika-mono', 'style': 'width:35%' }, k),
				cell,
				E('td', { 'class': 'td right', 'style': 'width:6em' },
					E('button', { 'class': 'btn cbi-button-edit', 'click': function() {
						editValue(k, values[k], function(nv) { values[k] = nv; dom.content(cell, nv); });
					} }, _('Edit')))
			]);
		});
		return E([], [
			E('p', { 'class': 'nijika-hint' }, _('%d of %d values').format(shown.length, Object.keys(values).length) +
				(keys.length > shown.length ? ' - ' + _('refine the filter to see more') : '')),
			E('table', { 'class': 'table' }, rows)
		]);
	},

	renderChain: function(tbl) {
		var recs = tbl.records || [];
		if (!recs.length)
			return E('em', {}, _('Table %s has no records.').format(tbl.table));
		var fields = [];
		recs.forEach(function(r) { Object.keys(r).forEach(function(k) { if (fields.indexOf(k) < 0) fields.push(k); }); });
		return E('div', { 'style': 'overflow-x:auto' }, E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [ E('th', { 'class': 'th left' }, _('Field')) ].concat(recs.map(function(r, i) {
				return E('th', { 'class': 'th left' }, '#' + i);
			})))
		].concat(fields.map(function(f) {
			return E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left nijika-mono' }, f) ].concat(recs.map(function(r, i) {
				var cell = E('td', { 'class': 'td left nijika-mono', 'style': 'cursor:pointer;word-break:break-all',
					'title': _('Click to edit %s.%d.%s').format(tbl.table, i, f) }, r[f] != null ? r[f] : '');
				cell.addEventListener('click', function() {
					editValue('%s.%d.%s'.format(tbl.table, i, f), r[f] || '', function(nv) { r[f] = nv; dom.content(cell, nv); });
				});
				return cell;
			})));
		}))));
	},

	render: function(mib) {
		if (!mib || mib.error)
			return E('p', { 'class': 'alert-message warning' }, (mib && mib.error) || _('Vendor stack not available'));

		var self = this, values = mib.values || {};
		var list = E('div', {}, this.renderScalars(values, ''));
		var filter = E('input', { 'class': 'cbi-input-text', 'placeholder': _('Filter keys or values, e.g. WLAN or PLOAM'),
			'style': 'width:100%;max-width:30em', 'keyup': function() { dom.content(list, self.renderScalars(values, filter.value)); } });

		var chains = (mib.chains || []).slice().sort(function(a, b) { return a.name < b.name ? -1 : 1; });
		var csel = E('select', { 'class': 'cbi-input-select' }, chains.map(function(c) {
			return E('option', { 'value': c.name, 'selected': c.name == 'ATM_VC_TBL' ? '' : null },
				'%s (%d/%s)'.format(c.name, c.num, c.max < 0 ? '∞' : c.max));
		}));
		var cout = E('div', {}, E('em', {}, _('Select a table.')));

		return E([], [
			nc.style(),
			E('h2', {}, _('MIB Browser')),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('This page shows the stock Realtek configuration database (MIB) and is used to change single keys. A change is saved like `flash set` (the stock configd writes it to flash shortly after, and before a reboot). WAN, firewall, LAN, WiFi and GPON keys are applied to the running stack as on the stock GUI; other keys take effect after a reboot.'),
				' ', E('strong', {}, _('A wrong value can make the device unreachable. Use Quick Setup for the common settings.'))
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Chain tables')),
				E('div', { 'class': 'cbi-value' }, [ csel, ' ',
					E('button', { 'class': 'btn cbi-button-action', 'click': function() {
						dom.content(cout, E('p', { 'class': 'spinning' }, _('Loading…')));
						return nc.callChain(csel.value).then(function(t) {
							dom.content(cout, (t && !t.error) ? self.renderChain(t) : E('em', {}, (t && t.error) || _('Read failed')));
						});
					} }, _('Show'))
				]),
				cout
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Values')),
				filter,
				list
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
