'use strict';
'require view';
'require poll';
'require dom';
'require nijika.common as nc';

function renderLink(st) {
	return nc.kvTable([
		[ _('ONU state'), nc.stateBadge(st.state, st.los) ],
		[ _('GPON serial number'), E('span', { 'class': 'nijika-mono' }, st.sn || '-') ],
		[ _('PON vendor ID'), E('span', { 'class': 'nijika-mono' }, st.vendor_id || '-') ],
		[ _('OLT vendor'), st.olt_vendor
			? E('span', { 'class': 'nijika-mono' }, '%s (%s)'.format(st.olt_vendor, st.olt_vendor_hex))
			: E('em', {}, _('not provisioned yet')) ],
		[ _('Uptime'), '%t'.format(st.uptime || 0) ]
	]);
}

function renderOptics(st) {
	return nc.kvTable([
		[ _('RX power') + ' (1490 nm)', nc.levelBar(st.rx_dbm, 'dBm', -32, -5, -27, -8) ],
		[ _('TX power') + ' (1310 nm)', nc.levelBar(st.tx_dbm, 'dBm', -2, 7, 0.5, 5) ],
		[ _('Temperature'), st.temp_c ? '%s °C'.format(st.temp_c) : '-' ],
		[ _('Supply voltage'), st.voltage_v ? '%s V'.format(st.voltage_v) : '-' ],
		[ _('Laser bias current'), st.bias_ma ? '%s mA'.format(st.bias_ma) : '-' ]
	]);
}

function renderAlarms(st) {
	var rows = (st.alarms || []).map(function(a) {
		var active = (a.status == 'yes');
		return E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td left', 'style': 'width:33%' }, a.name),
			E('td', { 'class': 'td left' }, E('span', { 'class': 'nijika-badge ' + (active ? 'bad' : 'ok') }, a.status))
		]);
	});
	if (!rows.length)
		rows.push(E('tr', { 'class': 'tr placeholder' }, E('td', { 'class': 'td' }, E('em', {}, _('No alarm information')))));
	return E('table', { 'class': 'table' }, rows);
}

function renderProvision(olt) {
	if (!olt || olt.error)
		return E('em', {}, olt && olt.error || _('No OMCI data'));

	var i131 = (olt.me131 && olt.me131.instances || [])[0] || { attrs: [] },
	    i256 = (olt.me256 && olt.me256.instances || [])[0] || { attrs: [] },
	    n84 = (olt.me84 && olt.me84.instances || []).length,
	    n171 = (olt.me171 && olt.me171.instances || []).length,
	    o5 = /^O5/.test(olt.state || ''),
	    warn = '';

	if (o5 && (!n84 || !n171))
		warn = E('p', { 'class': 'alert-message warning' },
			_('The OLT ranged this ONT (O5) but has not provisioned %s. The service profile is usually missing on the OLT side.')
				.format([ !n84 ? 'ME 84' : null, !n171 ? 'ME 171' : null ].filter(Boolean).join(' / ')));

	return E([], [
		warn,
		nc.kvTable([
			[ _('OLT vendor ID') + ' (ME 131)', nc.hexLabel(nc.attr(i131, 'OltVendorId')) ],
			[ _('OLT equipment ID'), nc.hexLabel(nc.attr(i131, 'EquipId')) ],
			[ _('OLT version'), nc.hexLabel(nc.attr(i131, 'Version')) ],
			[ _('ONT-G vendor / version') + ' (ME 256)', '%s / %s'.format(nc.hexLabel(nc.attr(i256, 'VID')), nc.hexLabel(nc.attr(i256, 'Version'))) ],
			[ _('Traffic management option'), nc.attr(i256, 'TraffMgtOpt') || '-' ],
			[ _('VLAN filters (ME 84)'), n84 ? String(n84) : E('em', {}, _('none')) ],
			[ _('Extended VLAN (ME 171)'), n171 ? String(n171) : E('em', {}, _('none')) ]
		]),
		E('p', {}, E('a', { 'href': L.url('admin/nijika/omci') }, _('Open the ME Explorer for details…')))
	]);
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(nc.callStatus(), {}),
			L.resolveDefault(nc.callOlt(), {})
		]);
	},

	render: function(data) {
		var st = data[0] || {}, olt = data[1] || {};

		var link = E('div', {}, renderLink(st)),
		    optics = E('div', {}, renderOptics(st)),
		    alarms = E('div', {}, renderAlarms(st)),
		    prov = E('div', {}, renderProvision(olt));

		poll.add(function() {
			return nc.callStatus().then(function(st) {
				if (!st || st.error)
					return;
				dom.content(link, renderLink(st));
				dom.content(optics, renderOptics(st));
				dom.content(alarms, renderAlarms(st));
			});
		}, 5);

		poll.add(function() {
			return nc.callOlt().then(function(olt) { dom.content(prov, renderProvision(olt)); });
		}, 30);

		return E([], [
			nc.style(),
			E('h2', {}, _('ONT Status')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Live GPON status of the built-in ONU, read from the stock Realtek stack (diag / omcicli).')),
			st.error ? E('p', { 'class': 'alert-message warning' }, st.error) : '',
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, _('PON link')), link ]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, _('Optical transceiver (BOSA)')), optics ]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, _('Alarms')), alarms ]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, _('OLT provisioning')), prov ])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
