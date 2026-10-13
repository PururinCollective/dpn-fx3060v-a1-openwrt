'use strict';
'require view';
'require dom';
'require ui';
'require nijika.common as nc';

/*
 * ME Explorer: what the OLT provisioned over OMCI (ME 131/256/84/171,
 * decoded like NIJIKA omci_olt.asp), a browser for any managed entity and
 * read-only diag output.
 */

var BROWSE = [ 131, 256, 257, 263, 264, 2, 7, 6, 5, 11, 53, 329, 45, 47, 84, 130, 171,
               262, 268, 266, 277, 278, 280, 281, 309, 310, 134, 347, 136, 137, 138, 150, 153, 340 ];

var DIAG = [
	[ 'onu-state', _('ONU state') ], [ 'alarms', _('Alarm status') ],
	[ 'transceiver', _('Transceiver') ], [ 'onu-info', _('ONU info') ],
	[ 'us-flow', _('Upstream flows') ], [ 'ds-flow', _('Downstream flows') ],
	[ 'interfaces', _('Interfaces') ], [ 'routes', _('Routes') ],
	[ 'bridge', _('Bridges') ], [ 'filter', _('iptables filter') ],
	[ 'nat', _('iptables nat') ], [ 'ppp', _('PPP') ], [ 'vendor-boot', _('Vendor log') ]
];

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
			return E('div', {}, [
				E('sup', { 'title': _('Filter outer') }, nc.fmtFilter(r.filterOuter)), '↘',
				E('sub', { 'title': _('Filter inner') }, nc.fmtFilter(r.filterInner)),
				' → ',
				E('sup', { 'title': _('Treatment outer') }, nc.fmtTreat(r.treatmentOuter)), '↘',
				E('sub', { 'title': _('Treatment inner') }, nc.fmtTreat(r.treatmentInner))
			]);
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

function renderInstance(cls, inst, idx) {
	var rows = (inst.attrs || []).map(function(a) {
		var v = a[1], dec = /^0x[0-9a-f]{6,}$/i.test(v) ? nc.hexToAscii(v) : null;
		return E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td left', 'style': 'width:30%' }, a[0]),
			E('td', { 'class': 'td left nijika-mono', 'style': 'white-space:pre-wrap' }, dec ? '%s  (%s)'.format(v, dec) : v)
		]);
	});
	var raw = E('div', { 'class': 'nijika-pre', 'style': 'display:none' }, inst.raw);
	return E('div', { 'class': 'cbi-section' }, [
		E('h4', {}, [
			_('Instance %d').format(idx + 1), ' ',
			E('span', { 'class': 'nijika-hint' }, nc.attr(inst, 'EntityId') || nc.attr(inst, 'EntityID') || ''), ' ',
			E('button', { 'class': 'btn cbi-button', 'click': function() {
				raw.style.display = (raw.style.display == 'none') ? 'block' : 'none';
			} }, _('Raw'))
		]),
		E('table', { 'class': 'table' }, rows),
		raw
	]);
}

return view.extend({
	load: function() {
		return L.resolveDefault(nc.callOlt(), {});
	},

	renderProvision: function(olt) {
		if (!olt || olt.error)
			return E('p', { 'class': 'alert-message warning' }, (olt && olt.error) || _('No OMCI data'));
		var o5 = /^O5/.test(olt.state || '');
		return E([], [
			E('p', {}, [ _('ONU state') + ': ', nc.stateBadge(olt.state, false) ]),
			E('h4', {}, 'ME 131 — ' + nc.meName(131)), renderMe131(olt.me131 || {}),
			E('h4', {}, 'ME 256 — ' + nc.meName(256)), renderMe256(olt.me256 || {}),
			E('h4', {}, 'ME 84 — ' + nc.meName(84)), renderMe84(olt.me84 || {}),
			E('h4', {}, 'ME 171 — ' + nc.meName(171)), renderMe171(olt.me171 || {}, o5),
			E('p', { 'class': 'nijika-hint' },
				_('Filter: "no tag" = untagged frames, "default" = default rule, "any" = any VID. Treatment: "copy inner/outer" keeps the received VID.'))
		]);
	},

	render: function(olt) {
		var prov = E('div', {}, this.renderProvision(olt));
		var self = this;

		/* ME browser */
		var sel = E('select', { 'class': 'cbi-input-select' }, BROWSE.map(function(c) {
			return E('option', { 'value': c }, '%d — %s'.format(c, nc.meName(c)));
		}));
		var num = E('input', { 'class': 'cbi-input-text', 'type': 'number', 'min': 1, 'max': 65535,
			'placeholder': _('class id'), 'style': 'width:8em' });
		var out = E('div', {}, E('em', {}, _('Select a managed entity and press Get.')));

		var fetchMe = function() {
			var cls = +(num.value || sel.value);
			dom.content(out, E('p', { 'class': 'spinning' }, _('Reading ME %d…').format(cls)));
			return nc.callMe(cls).then(function(me) {
				if (!me || me.error)
					return dom.content(out, E('p', { 'class': 'alert-message warning' }, (me && me.error) || _('Read failed')));
				var insts = me.instances || [];
				dom.content(out, [
					E('p', {}, '%d — %s: %d %s'.format(cls, me.name || nc.meName(cls), insts.length, _('instance(s)'))),
					insts.length ? insts.map(function(i, n) { return renderInstance(cls, i, n); })
					             : E('em', {}, _('No instances (not created by the OLT or not supported).'))
				]);
			});
		};

		/* diag */
		var dout = E('div', { 'class': 'nijika-pre' }, _('Pick a command.'));
		var dbuttons = DIAG.map(function(d) {
			return E('button', { 'class': 'btn cbi-button', 'style': 'margin:0 .3em .3em 0', 'click': function() {
				dom.content(dout, _('Running…'));
				return nc.callDiag(d[0]).then(function(r) {
					dom.content(dout, (r && (r.output || r.error)) || _('(no output)'));
				});
			} }, d[1]);
		});

		return E([], [
			nc.style(),
			E('h2', {}, _('ME Explorer')),
			E('div', { 'class': 'cbi-map-descr' },
				_('OMCI managed entities as provisioned by the OLT. An OLT can range the ONT to O5 yet withhold ME 84/171; this page shows exactly what arrived.')),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('OLT provisioning') + ' ',
					E('button', { 'class': 'btn cbi-button-action', 'click': function() {
						return nc.callOlt().then(function(o) { dom.content(prov, self.renderProvision(o)); });
					} }, _('Refresh')) ]),
				prov
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Managed entity browser')),
				E('div', { 'class': 'cbi-value' }, [
					sel, ' ', _('or'), ' ', num, ' ',
					E('button', { 'class': 'btn cbi-button-action', 'click': fetchMe }, _('Get'))
				]),
				out
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Diagnostics')),
				E('div', {}, dbuttons),
				dout
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
