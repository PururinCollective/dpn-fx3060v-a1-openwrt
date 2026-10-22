// SPDX-License-Identifier: Apache-2.0

'use strict';
'require view';
'require form';
'require ui';
'require nijika.common as nc';

/*
 * ONT identity as reported to the OLT over OMCI (vendor, model, versions,
 * OLT compatibility mode). Presets port NIJIKA `emulate.sh`.
 */

var FIELDS = [
	[ 'PON_VENDOR_ID', _('PON vendor ID'), _('4 characters, e.g. HWTC, ZTEG, ALCL') ],
	[ 'GPON_ONU_MODEL', _('ONU model (ME 256 equipment ID)') ],
	[ 'HW_HWVER', _('Hardware version (ME 256 version)') ],
	[ 'OMCI_SW_VER1', _('Software image 0 version (ME 7)') ],
	[ 'OMCI_SW_VER2', _('Software image 1 version (ME 7)') ],
	[ 'OMCI_OLT_MODE', _('OMCI OLT compatibility mode'), _('0 = default, 1 = Huawei, 2 = ZTE, 3 = custom, 21 = NIJIKA') ],
	[ 'OMCI_TM_OPT', _('Traffic management option'), _('0 = priority, 1 = rate, 2 = priority and rate controlled') ],
	[ 'OMCI_VENDOR_PRODUCT_CODE', _('Vendor product code') ],
	[ 'OUI', _('OUI'), _('Bytes separated by commas, e.g. 78,57,73') ],
	[ 'HW_CWMP_MANUFACTURER', _('TR-069 manufacturer') ],
	[ 'HW_CWMP_PRODUCTCLASS', _('TR-069 product class') ],
	[ 'HW_SERIAL_NO', _('Hardware serial number') ],
	[ 'OMCI_CUSTOM_BDP', _('OMCI_CUSTOM_BDP'), _('Realtek OMCI feature bits; see `nijika mode`') ],
	[ 'OMCI_CUSTOM_RDP', _('OMCI_CUSTOM_RDP') ],
	[ 'OMCI_CUSTOM_ME', _('OMCI_CUSTOM_ME') ]
];

return view.extend({
	load: function() {
		return nc.callIdentGet();
	},

	render: function(id) {
		if (!id || id.error)
			return E('p', { 'class': 'alert-message warning' }, (id && id.error) || _('Vendor stack not available'));

		this.current = id.current || {};
		var data = { ident: Object.assign({}, this.current) };
		var m, s, o;

		m = new form.JSONMap(data, _('ONT Identity Settings'),
			_('This page is used to configure the identity the ONT reports to the OLT. Some OLTs provision services (ME 84/171) only for known vendors and models. A change takes effect after a reboot.'));
		this.map = m;

		s = m.section(form.NamedSection, 'ident', 'ident', _('Current values'));
		FIELDS.forEach(function(f) {
			o = s.option(form.Value, f[0], f[1], f[2]);
			o.placeholder = (id.defaults || {})[f[0]] || '';
		});

		var sel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': 'factory' }, _('Stock D-Link DPN-FX3060V (factory defaults)'))
		].concat((id.presets || []).map(function(p) {
			return E('option', { 'value': p.id }, p.label);
		})));

		var presets = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Presets')),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Emulate')),
				E('div', { 'class': 'cbi-value-field' }, [
					sel, ' ',
					E('button', { 'class': 'btn cbi-button-apply', 'click': ui.createHandlerFn(this, function() {
						return nc.callIdentSet(sel.value).then(function(r) {
							if (r && r.error)
								throw new Error(r.error);
							nc.rebootPrompt(nc, _('Identity preset "%s" applied.').format(sel.options[sel.selectedIndex].text));
						}).catch(function(e) {
							ui.addNotification(null, E('p', e.message || e), 'danger');
						});
					}) }, _('Apply preset')),
					E('div', { 'class': 'cbi-value-description' },
						_('Writes all identity values at once; edit single values below.'))
				])
			])
		]);

		return m.render().then(function(node) { return E([], [ nc.style(), node, presets ]); });
	},

	handleSave: function(ev) {
		var self = this;
		return this.map.save().then(function() {
			var pairs = [];
			FIELDS.forEach(function(f) {
				var v = self.map.data.get('json', 'ident', f[0]);
				if (v != null && v !== self.current[f[0]])
					pairs.push([ f[0], v ]);
			});
			if (!pairs.length) {
				ui.addNotification(null, E('p', _('No changes.')), 'info');
				return null;
			}
			return nc.callMibSet(pairs).then(function(r) {
				if (r && r.failed && r.failed.length)
					throw new Error(_('Failed to set: %s').format(r.failed.join(', ')));
				pairs.forEach(function(p) { self.current[p[0]] = p[1]; });
				return r;
			});
		});
	},

	handleSaveApply: function(ev) {
		return this.handleSave(ev).then(function(r) {
			if (r)
				nc.rebootPrompt(nc);
		}).catch(function(e) {
			ui.addNotification(null, E('p', e.message || e), 'danger');
		});
	},

	handleReset: null
});
