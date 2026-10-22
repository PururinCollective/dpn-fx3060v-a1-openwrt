// SPDX-License-Identifier: Apache-2.0

'use strict';
'require baseclass';
'require nijika.common as nc';

/*
 * Status > Overview, PON / ONT (after System): the fibre link drawn as
 *
 *               ------ 1490 nm ------>          RX  -16.2 dBm
 *   OLT (ALCL)                        NijikaWrt WAN 203.0.113.7
 *               <----- 1310 nm -------          TX  2.1 dBm
 *
 * with light pulses running on a lane while there is light on it (the
 * MA5671a / Peter-Pon status card's idea, as plain SVG + CSS). One node is
 * built once and updated on every poll: re-inserting it would restart the
 * animation every few seconds. Motion is CSS transform / opacity only, off
 * with prefers-reduced-motion.
 */

var NS = 'http://www.w3.org/2000/svg';
var X0 = 128, X1 = 420;		/* lane start / end */
var PULSES = 4;

var CSS = '\
.nj-pon{width:100%;max-width:760px;height:auto;display:block;margin:.4em 0 .8em;color:var(--text-color-high,currentColor)}\
.nj-pon .box{fill:rgba(127,127,127,.10);stroke:currentColor;stroke-opacity:.35}\
.nj-pon text{fill:currentColor;font-size:13px}\
.nj-pon .big{font-size:15px;font-weight:bold}\
.nj-pon .dim{opacity:.6;font-size:11px}\
.nj-pon .lane{stroke:currentColor;stroke-opacity:.25;stroke-width:2;fill:none}\
.nj-pon .lane.ok{stroke:#1f9d55;stroke-opacity:.75}.nj-pon .lane.warn{stroke:#d99a00;stroke-opacity:.8}\
.nj-pon .lane.bad{stroke:#cc1f1a;stroke-opacity:.8}.nj-pon .lane.off{stroke-dasharray:5 5}\
.nj-pon .head{fill:currentColor;fill-opacity:.35}.nj-pon .head.ok{fill:#1f9d55;fill-opacity:.8}\
.nj-pon .head.warn{fill:#d99a00;fill-opacity:.85}.nj-pon .head.bad{fill:#cc1f1a;fill-opacity:.85}\
.nj-pon .val.ok{fill:#1f9d55}.nj-pon .val.warn{fill:#d99a00}.nj-pon .val.bad{fill:#cc1f1a}\
.nj-pon .p{opacity:0;will-change:transform,opacity}\
.nj-pon .ds .p{fill:#00b4ff}.nj-pon .us .p{fill:#ff8a00}\
.nj-pon .ds.on .p{animation:nj-ds 2.2s linear infinite}\
.nj-pon .us.on .p{animation:nj-us 2.2s linear infinite}\
@keyframes nj-ds{0%{transform:translateX(0);opacity:0}10%{opacity:1}88%{opacity:1}100%{transform:translateX(' + (X1 - X0) + 'px);opacity:0}}\
@keyframes nj-us{0%{transform:translateX(0);opacity:0}10%{opacity:1}88%{opacity:1}100%{transform:translateX(-' + (X1 - X0) + 'px);opacity:0}}\
@media (prefers-reduced-motion:reduce){.nj-pon .ds.on .p,.nj-pon .us.on .p{animation:none;opacity:0}}\
';

function svg(tag, attrs, children) {
	var el = document.createElementNS(NS, tag);
	for (var k in attrs)
		if (attrs[k] != null)
			el.setAttribute(k, attrs[k]);
	(children || []).forEach(function(c) {
		el.appendChild(typeof(c) == 'string' ? document.createTextNode(c) : c);
	});
	return el;
}

/* RX window of a class B+ ONT: -28..-8 dBm (+/-1 dB: weak but usable) */
function rxClass(v) {
	if (isNaN(v)) return 'off';
	return (v >= -27 && v <= -8) ? 'ok' : (v >= -28 && v <= -7) ? 'warn' : 'bad';
}

function txClass(v) {
	if (isNaN(v)) return 'off';
	return (v >= 0.5 && v <= 5) ? 'ok' : (v >= -0.5 && v <= 6) ? 'warn' : 'bad';
}

var card = {
	node: null, el: {},

	build: function() {
		var el = this.el, lanes = [];

		function lane(cls, y, ltr, label) {
			var g = svg('g', { 'class': cls });
			el[cls + 'Line'] = svg('line', { 'class': 'lane', x1: X0, y1: y, x2: X1, y2: y });
			el[cls + 'Head'] = svg('path', { 'class': 'head',
				d: ltr ? 'M%d %d l-9 -5 v10 z'.format(X1 + 2, y) : 'M%d %d l9 -5 v10 z'.format(X0 - 2, y) });
			g.appendChild(el[cls + 'Line']);
			g.appendChild(el[cls + 'Head']);
			g.appendChild(svg('text', { x: (X0 + X1) / 2, y: y - 7, 'text-anchor': 'middle', 'class': 'dim' }, [ label ]));
			for (var i = 0; i < PULSES; i++)
				g.appendChild(svg('circle', { 'class': 'p', cx: ltr ? X0 : X1, cy: y, r: 3.5,
					style: 'animation-delay:-%.2fs'.format(2.2 * i / PULSES) }));
			el[cls] = g;
			lanes.push(g);
		}

		lane('ds', 44, true, _('1490 nm downstream'));
		lane('us', 92, false, _('1310 nm upstream'));

		el.olt = svg('text', { x: 58, y: 64, 'text-anchor': 'middle', 'class': 'big' }, [ 'OLT' ]);
		el.oltVendor = svg('text', { x: 58, y: 82, 'text-anchor': 'middle', 'class': 'dim' }, [ '' ]);
		el.rx = svg('text', { x: 562, y: 48, 'class': 'val' }, [ '' ]);
		el.wan = svg('text', { x: 562, y: 72 }, [ '' ]);
		el.tx = svg('text', { x: 562, y: 96, 'class': 'val' }, [ '' ]);

		this.node = svg('svg', { 'class': 'nj-pon', viewBox: '0 0 760 128', role: 'img' }, [
			svg('title', {}, [ _('Fibre link between the OLT and this router') ]),
			svg('rect', { 'class': 'box', x: 4, y: 30, width: 108, height: 72, rx: 10 }),
			el.olt, el.oltVendor,
			lanes[0], lanes[1],
			svg('rect', { 'class': 'box', x: 432, y: 30, width: 118, height: 72, rx: 10 }),
			svg('text', { x: 491, y: 64, 'text-anchor': 'middle', 'class': 'big' }, [ 'NijikaWrt' ]),
			svg('text', { x: 491, y: 82, 'text-anchor': 'middle', 'class': 'dim' }, [ 'ONT' ]),
			el.rx, el.wan, el.tx
		]);
		this.wrap = E('div', {}, [ E('style', {}, CSS), nc.style(), this.node, this.table = E('div') ]);
	},

	update: function(st, wans) {
		var el = this.el, los = !!st.los, rx = parseFloat(st.rx_dbm), tx = parseFloat(st.tx_dbm);
		var rc = los ? 'off' : rxClass(rx), tc = txClass(tx);
		var inet = wans.filter(function(w) { return w.default_route && (w.ip4 || w.ip6); })[0] ||
			wans.filter(function(w) { return w.ip4; })[0];

		[ [ 'ds', rc, !los && !isNaN(rx) ], [ 'us', tc, !isNaN(tx) ] ].forEach(function(l) {
			el[l[0]].setAttribute('class', l[0] + (l[2] ? ' on' : ''));
			el[l[0] + 'Line'].setAttribute('class', 'lane ' + l[1]);
			el[l[0] + 'Head'].setAttribute('class', 'head ' + l[1]);
		});

		/* vendor id of ME 131; some OLTs (and OLT sticks) send none */
		var vendor = /[A-Za-z0-9]{2}/.test(st.olt_vendor || '') ? st.olt_vendor : '';
		el.oltVendor.textContent = vendor ? '(%s)'.format(vendor) : (los ? _('no light') : '');
		el.rx.textContent = 'RX  ' + (los || isNaN(rx) ? _('no light') : '%.1f dBm'.format(rx));
		el.rx.setAttribute('class', 'val ' + rc);
		el.tx.textContent = 'TX  ' + (isNaN(tx) ? _('off') : '%.1f dBm'.format(tx));
		el.tx.setAttribute('class', 'val ' + tc);
		el.wan.textContent = 'WAN ' + (inet ? (inet.ip4 || inet.ip6) : '-');

		this.table.replaceChildren(nc.kvTable([
			[ _('ONU state'), nc.stateBadge(st.state, st.los) ],
			[ _('Temperature'), st.temp_c ? '%s °C'.format(st.temp_c) : '-' ],
			[ _('GPON serial number'), st.sn || '-' ],
			[ _('Details'), E('a', { 'href': L.url('admin/nijika/status') }, _('PON → ONT Status')) ]
		]));
	}
};

return baseclass.extend({
	title: _('PON / ONT'),

	load: function() {
		return Promise.all([ L.resolveDefault(nc.callStatus(), {}), nc.wanStatus() ]);
	},

	render: function(data) {
		var st = data[0] || {};
		if (st.error)
			return E('em', {}, st.error);

		if (!card.node)
			card.build();
		card.update(st, data[1] || []);
		/* the same node every poll, inserted only when not in the page yet */
		return card.wrap.isConnected ? null : card.wrap;
	}
});
