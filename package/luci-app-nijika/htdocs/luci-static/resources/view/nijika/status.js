// SPDX-License-Identifier: Apache-2.0

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

function table(headers, rows, empty) {
	return E('table', { 'class': 'table' }, [
		E('tr', { 'class': 'tr table-titles' }, headers.map(function(h) { return E('th', { 'class': 'th left' }, h); }))
	].concat(rows.length ? rows.map(function(r) {
		return E('tr', { 'class': 'tr' }, r.map(function(c) { return E('td', { 'class': 'td left' }, c); }));
	}) : [ E('tr', { 'class': 'tr placeholder' }, E('td', { 'class': 'td', 'colspan': headers.length }, E('em', {}, empty))) ]));
}

function renderMe131(me) {
	var rows = (me.instances || []).map(function(i) {
		return [ nc.attr(i, 'EntityId') || '-',
			E('strong', {}, nc.hexLabel(nc.attr(i, 'OltVendorId'))),
			nc.hexLabel(nc.attr(i, 'EquipId')), nc.hexLabel(nc.attr(i, 'Version')),
			nc.attr(i, 'ToDInfo') || '-' ];
	});
	return table([ _('Entity'), _('OLT vendor'), _('Equipment ID'), _('Version'), _('ToD info') ], rows,
		_('OLT has not authenticated this ONT yet.'));
}

function renderMe256(me) {
	var i = (me.instances || [])[0];
	if (!i)
		return E('em', {}, _('No ONT-G instance'));
	return nc.kvTable([
		[ _('Vendor ID'), nc.hexLabel(nc.attr(i, 'VID')) ],
		[ _('Version'), nc.hexLabel(nc.attr(i, 'Version')) ],
		[ _('Serial number'), nc.hexLabel(nc.attr(i, 'SerialNum')) ],
		[ _('Traffic management option'), { 0: _('0 - priority controlled'), 1: _('1 - rate controlled'), 2: _('2 - priority and rate controlled') }[nc.attr(i, 'TraffMgtOpt')] || nc.attr(i, 'TraffMgtOpt') ],
		[ _('Admin / operational state'), '%s / %s'.format(nc.attr(i, 'AdminState') || '-', nc.attr(i, 'OpState') || '-') ],
		[ _('ONT state'), nc.attr(i, 'OntState') || '-' ]
	]);
}

function renderMe84(me) {
	var rows = (me.instances || []).map(function(i) {
		var vids = nc.vtfdVids(i);
		return [ nc.attr(i, 'EntityID') || nc.attr(i, 'EntityId') || '-',
			nc.attr(i, 'FwdOp') || '-',
			vids.length ? E('strong', {}, vids.join(', ')) : E('em', {}, _('none')),
			nc.attr(i, 'NumOfEntries') || '-' ];
	});
	return table([ _('Entity'), _('Forward op'), _('VLAN IDs'), _('Entries') ], rows,
		_('No VLAN tagging filter provisioned (ME 84 withheld by the OLT?)'));
}

function renderMe171(me, o5) {
	var rows = (me.instances || []).map(function(i) {
		var rules = nc.extVlanRules(i), at = nc.attr(i, 'AssociationType'), mp = nc.attr(i, 'AssociatedMePoint');
		var rcell = rules.length ? E('div', { 'class': 'nijika-vlan' }, rules.map(function(r) {
			/* G.988 treatment "tags to remove": 0-2 tags popped, 3 = discard */
			var rm = r.treatmentOuter && r.treatmentOuter.rm;
			return E('div', {}, [
				E('sup', { 'title': _('Filter outer') }, nc.fmtFilter(r.filterOuter)), '↘',
				E('sub', { 'title': _('Filter inner') }, nc.fmtFilter(r.filterInner)),
				' → '
			].concat(rm == '3' ? [ E('span', { 'class': 'drop', 'title': _('Frame is discarded') }, _('drop')) ] : [
				(rm && rm != '0') ? E('span', { 'class': 'pop', 'title': _('Tags removed') }, _('pop %s').format(rm) + ' ') : '',
				E('sup', { 'title': _('Treatment outer') }, nc.fmtTreat(r.treatmentOuter)), '↘',
				E('sub', { 'title': _('Treatment inner') }, nc.fmtTreat(r.treatmentInner))
			]));
		})) : E('em', {}, o5 ? _('Port is disabled by OLT') : '-');
		var uni = nc.uniLabel(at, mp), type = nc.ASSOC_TYPES[at] || at || '?';
		return [ nc.attr(i, 'EntityId') || '-', mp || '-',
			(uni == type) ? uni : '%s (%s)'.format(uni, type),
			rcell ];
	});
	return table([ _('Entity'), _('ME point'), _('UNI'), E('span', { 'class': 'nijika-vlan' }, [
		_('Rules') + ' ', E('sup', {}, _('outer')), '↘', E('sub', {}, _('inner')), ' → ',
		E('sup', {}, _('outer')), '↘', E('sub', {}, _('inner')) ]) ], rows,
		_('No extended VLAN operation provisioned (ME 171 withheld by the OLT?)'));
}

/* What the OLT provisioned over OMCI: ME 131 OLT-G, ME 256 ONT-G, ME 84
 * VLAN tagging filter, ME 171 extended VLAN operation (as NIJIKA
 * omci_olt.asp). An OLT can range the ONT to O5 and still withhold 84/171. */
function renderProvision(olt) {
	if (!olt || olt.error)
		return E('em', {}, olt && olt.error || _('No OMCI data'));

	var n84 = (olt.me84 && olt.me84.instances || []).length,
	    n171 = (olt.me171 && olt.me171.instances || []).length,
	    o5 = /^O5/.test(olt.state || ''),
	    warn = '';

	if (o5 && (!n84 || !n171))
		warn = E('p', { 'class': 'alert-message warning' },
			_('The OLT ranged this ONT (O5) but has not provisioned %s. The service profile is usually missing on the OLT side.')
				.format([ !n84 ? 'ME 84' : null, !n171 ? 'ME 171' : null ].filter(Boolean).join(' / ')));

	return E([], [
		warn,
		E('h4', {}, 'ME 131 - ' + nc.meName(131)), renderMe131(olt.me131 || {}),
		E('h4', {}, 'ME 256 - ' + nc.meName(256)), renderMe256(olt.me256 || {}),
		E('h4', {}, 'ME 84 - ' + nc.meName(84)), renderMe84(olt.me84 || {}),
		E('h4', {}, 'ME 171 - ' + nc.meName(171)), renderMe171(olt.me171 || {}, o5),
		E('p', { 'class': 'nijika-hint' },
			_('Filter: "no tag" = untagged frames, "default" = default rule, "any" = any VID. Treatment: "pop N" removes N received tags, "drop" discards the frame, "copy inner/outer" keeps the received VID.'))
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
				_('This page shows the current GPON status of the built-in ONU, read from the stock Realtek stack (diag, omcicli).')),
			st.error ? E('p', { 'class': 'alert-message warning' }, st.error) : '',
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, _('PON link')), link ]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, _('Optical transceiver (BOSA)')), optics ]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, _('Alarms')), alarms ]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, _('OMCI provisioning')), prov ])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
