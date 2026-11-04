// SPDX-License-Identifier: Apache-2.0

'use strict';
'require baseclass';
'require rpc';
'require nijika.common as nc';

/*
 * Status > Overview: the Fibre (GPON) card, after the status cards of Peter-Pon
 * (luci-app-gpon 15_gpon.js) and of RemixWrt (sk-g7220-openwrt 15_aero_fibre.js).
 * Left: the ONT with its fibre, the downstream light (1490 nm, continuous) and
 * the upstream laser (1310 nm, bursts), and the PON, LOS and WAN LEDs. Right:
 * ONU state, RX power on the class B+ window, TX power, temperature of the
 * BOSA, the WAN connection of the default route and its traffic. Footer:
 * release, links and details.
 *
 * Data: rpcd nijika status and wan_status, luci-rpc getNetworkDevices. The card
 * is built once and updated in place: a re-inserted node restarts the
 * animation. The style sheet stays in the card: the Footstrap router keeps a
 * style sheet in #view. Motion is CSS transform and opacity only, off with
 * prefers-reduced-motion.
 */

var callBoard = rpc.declare({ object: 'system', method: 'board' });

var RX_LO = -36, RX_HI = -5;		/* domain of the RX bar, dBm */
var RX_OK_LO = -27, RX_OK_HI = -8;	/* class B+ -28..-8 dBm, 1 dB margin at the low end */

var COL = { ok: '#2fbf71', warn: '#f0a020', err: '#e5484d' };
var HALO = { ok: 'rgba(47,191,113,.2)', warn: 'rgba(240,160,32,.2)', err: 'rgba(229,72,77,.2)' };

var CSS = '\
.nj-w{container-type:inline-size}\
.nj{display:grid;grid-template-columns:minmax(200px,310px) minmax(0,1fr);gap:.9em 1.8em;align-items:center}\
.nj-art{min-width:0}.nj-art svg{width:100%;height:auto;display:block;overflow:visible}\
.nj-vals{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,230px),1fr));gap:.85em 1.6em;min-width:0}\
.nj-v{min-width:0}\
.nj-l,.nj-s{font-size:12.5px;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\
.nj-n{display:flex;align-items:center;gap:.45em;font-size:1.3em;font-weight:650;line-height:1.3;font-variant-numeric:tabular-nums;min-width:0}\
.nj-n>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\
.nj-v[data-row="traffic"] .nj-n>span:last-child{white-space:normal;overflow:visible}\
.nj-dot{flex:none;width:9px;height:9px;border-radius:50%;background:var(--nj-c,transparent);box-shadow:0 0 0 3px var(--nj-h,transparent)}\
.nj-dot.none{display:none}\
.nj-ds{color:#16a5c9}.nj-us{color:#e08a12}\
.nj-bar{position:relative;height:36px;margin:.2em 0 0}\
.nj-trk{position:absolute;left:0;right:0;top:9px;height:7px;border-radius:4px;overflow:hidden;background:rgba(127,127,127,.18)}\
.nj-z{position:absolute;top:0;bottom:0}\
.nj-mk{position:absolute;top:6px;width:5px;height:13px;margin-left:-2.5px;border-radius:3px;background:var(--nj-c,currentColor);box-shadow:0 0 0 2px rgba(127,127,127,.35);transition:left .6s cubic-bezier(.2,.8,.2,1)}\
.nj-mk[hidden]{display:none}\
.nj-tk{position:absolute;top:22px;font-size:10.5px;opacity:.72;transform:translateX(-50%);white-space:nowrap;font-variant-numeric:tabular-nums}\
.nj-foot{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5em 1.2em;border-top:1px solid rgba(127,127,127,.3);padding-top:.6em;font-size:12.5px}\
.nj-brand{display:inline-flex;align-items:center;gap:.5em;flex-wrap:wrap}.nj-brand b{font-weight:650}\
.nj-brand a{text-decoration:none;font-weight:600}\
.nj-sn{opacity:.72;font-variant-numeric:tabular-nums}\
.nj-det{grid-column:1/-1;font-size:12px;opacity:.72;line-height:1.5;margin-top:-.3em}\
.nj-det span+span::before{content:"\\00b7";margin:0 .55em;opacity:.7}\
@container (max-width:560px){.nj{grid-template-columns:minmax(0,1fr)}.nj-art{max-width:360px}}\
.ng-shell{fill:currentColor;fill-opacity:.07;stroke:currentColor;stroke-opacity:.38;stroke-width:1.4}\
.ng-face{fill:currentColor;fill-opacity:.05;stroke:currentColor;stroke-opacity:.2}\
.ng-port{fill:currentColor;fill-opacity:.16;stroke:currentColor;stroke-opacity:.45}\
.ng-jacket{fill:none;stroke:#e9c23a;stroke-width:5;stroke-linecap:round;stroke-opacity:.85}\
.ng-conn{fill:#2fa46a;fill-opacity:.85;stroke:#1f7a4d}\
.ng-bosa{fill:currentColor;fill-opacity:.14;stroke:currentColor;stroke-opacity:.5}\
.ng-txt{fill:currentColor;fill-opacity:.62;font:600 9px sans-serif;letter-spacing:.06em}\
.ng-brand{fill:currentColor;fill-opacity:.82;font:700 11px sans-serif;letter-spacing:.08em}\
.ng-nm{font:600 8.5px sans-serif}.ng-nm.ds{fill:#16a5c9}.ng-nm.us{fill:#e08a12}\
.ng-wifi{fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.6;stroke-linecap:round}\
.ng-led{fill:currentColor;fill-opacity:.18}\
.ng-led.ok{fill:#2fbf71;fill-opacity:1;filter:drop-shadow(0 0 2.5px #2fbf71)}\
.ng-led.warn{fill:#f0a020;fill-opacity:1;filter:drop-shadow(0 0 2.5px #f0a020);animation:ng-blink 1s steps(2) infinite}\
.ng-led.err{fill:#e5484d;fill-opacity:1;filter:drop-shadow(0 0 2.5px #e5484d)}\
.ng-ledl{fill:currentColor;fill-opacity:.55;font:600 6.5px sans-serif;letter-spacing:.04em}\
.ng-ds circle{fill:#22c3ee;filter:drop-shadow(0 0 3px #22c3ee)}\
.ng-us rect{fill:#f5a524;filter:drop-shadow(0 0 3px #f5a524)}\
.ng-ds .p{animation:ng-in 1.8s linear infinite;animation-delay:calc(var(--k) * -1.8s)}\
.ng-us .p{opacity:0;animation:ng-out 1.2s linear infinite;animation-delay:calc(var(--k) * -1.2s)}\
@keyframes ng-in{from{transform:translateX(0);opacity:0}12%{opacity:1}88%{opacity:1}to{transform:translateX(96px);opacity:0}}\
@keyframes ng-out{from{transform:translateX(0);opacity:0}10%{opacity:1}60%{opacity:1}70%,to{transform:translateX(-96px);opacity:0}}\
@keyframes ng-blink{to{visibility:hidden}}\
.ng-glow{fill:#22c3ee;opacity:0;transition:opacity .6s}\
.ng[data-light="1"] .ng-glow{opacity:.35;animation:ng-pulse 2.4s ease-in-out infinite}\
@keyframes ng-pulse{50%{opacity:.12}}\
.ng:not([data-light="1"]) .ng-ds,.ng:not([data-tx="1"]) .ng-us{display:none}\
@media (prefers-reduced-motion:reduce){.ng-ds .p,.ng-us .p,.ng-led.warn,.ng[data-light="1"] .ng-glow{animation:none}.nj-mk{transition:none}}\
';

function svg(tag, attrs, children) {
	var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (var k in attrs)
		if (attrs[k] != null)
			el.setAttribute(k, attrs[k]);
	(children || []).forEach(function(c) {
		el.appendChild(typeof(c) == 'string' ? document.createTextNode(c) : c);
	});
	return el;
}

/* the ONT: fibre in on the left (green SC/APC), the BOSA behind the PON port,
 * LEDs on the front, WiFi above */
function drawing(model) {
	var ds = svg('g', { 'class': 'ng-ds' }), us = svg('g', { 'class': 'ng-us' }), k;

	for (k = 0; k < 4; k++)
		ds.appendChild(svg('g', { 'class': 'p', style: '--k:' + (k / 4) }, [ svg('circle', { cx: 4, cy: 74, r: 2.6 }) ]));
	for (k = 0; k < 3; k++)
		us.appendChild(svg('g', { 'class': 'p', style: '--k:' + (k / 3) }, [ svg('rect', { x: 94, y: 79.5, width: 11, height: 3.6, rx: 1.8 }) ]));

	function led(x, name) {
		return [ svg('circle', { 'class': 'ng-led', 'data-led': name, cx: x, cy: 112, r: 3.2 }),
			svg('text', { 'class': 'ng-ledl', x: x, y: 125, 'text-anchor': 'middle' }, [ name ]) ];
	}

	return svg('svg', { 'class': 'ng', viewBox: '0 0 310 140', role: 'img', 'aria-label': model }, [
		svg('path', { 'class': 'ng-jacket', d: 'M2,78 C30,78 44,78 74,78' }),
		svg('rect', { 'class': 'ng-conn', x: 74, y: 69, width: 22, height: 18, rx: 2.5 }),
		ds, us,
		svg('rect', { 'class': 'ng-shell', x: 100, y: 34, width: 204, height: 98, rx: 12 }),
		svg('rect', { 'class': 'ng-face', x: 108, y: 100, width: 188, height: 28, rx: 6 }),
		svg('rect', { 'class': 'ng-port', x: 96, y: 70, width: 8, height: 16, rx: 1.5 }),
		svg('circle', { 'class': 'ng-glow', cx: 122, cy: 78, r: 13 }),
		svg('rect', { 'class': 'ng-bosa', x: 112, y: 70, width: 20, height: 16, rx: 3 }),
		svg('text', { 'class': 'ng-nm ds', x: 138, y: 73 }, [ '1490 nm ↓' ]),
		svg('text', { 'class': 'ng-nm us', x: 138, y: 87 }, [ '1310 nm ↑' ]),
		svg('text', { 'class': 'ng-brand', x: 296, y: 58, 'text-anchor': 'end' }, [ model ]),
		svg('text', { 'class': 'ng-txt', x: 296, y: 72, 'text-anchor': 'end' }, [ 'GPON ONT' ]),
		svg('path', { 'class': 'ng-wifi', d: 'M190,24 a14,14 0 0 1 20,0 M184,18 a22,22 0 0 1 32,0 M178,12 a30,30 0 0 1 44,0' }),
		svg('circle', { cx: 200, cy: 28, r: 2.2, fill: 'currentColor', 'fill-opacity': '.4' })
	].concat(led(146, 'PON'), led(202, 'LOS'), led(258, 'WAN')));
}

function pos(dbm) {
	return ((Math.max(RX_LO, Math.min(RX_HI, dbm)) - RX_LO) / (RX_HI - RX_LO) * 100).toFixed(2) + '%';
}

/* ok inside [lo,hi], warn within margin of it, else err */
function level(v, lo, hi, margin) {
	return (v >= lo && v <= hi) ? 'ok' : (v >= lo - margin && v <= hi + margin) ? 'warn' : 'err';
}

function rate(bps) {
	if (bps == null || !isFinite(bps)) return '-';
	if (bps >= 1e9) return '%.2f Gbit/s'.format(bps / 1e9);
	if (bps >= 1e6) return '%.1f Mbit/s'.format(bps / 1e6);
	if (bps >= 1e3) return '%.0f kbit/s'.format(bps / 1e3);
	return '%.0f bit/s'.format(bps);
}

var card = {
	wrap: null, rows: null, art: null, prev: null, rx: null, tx: null,

	build: function(board) {
		function row(key, label) {
			var dot = E('span', { 'class': 'nj-dot none' }), val = E('span', {}, [ '-' ]);
			var lbl = E('div', { 'class': 'nj-l' }, [ label ]), sub = E('div', { 'class': 'nj-s' }, [ ' ' ]);
			return { node: E('div', { 'class': 'nj-v', 'data-row': key }, [ lbl, E('div', { 'class': 'nj-n' }, [ dot, val ]), sub ]),
				dot: dot, val: val, lbl: lbl, sub: sub };
		}

		function zone(a, z, c) {
			return E('span', { 'class': 'nj-z', style: 'left:%s;right:calc(100%% - %s);background:%s'.format(pos(a), pos(z), c) });
		}

		var R = this.rows = {
			state: row('state', _('ONU state')),
			rx: row('rx', _('RX power')),
			tx: row('tx', _('TX power')),
			temp: row('temp', _('Temperature')),
			wan: row('wan', _('WAN')),
			traffic: row('traffic', _('Traffic'))
		};

		/* the class B+ window as zones, the reading as a marker */
		this.mk = E('span', { 'class': 'nj-mk', hidden: 'hidden' });
		R.rx.sub.replaceWith(E('div', { 'class': 'nj-bar', title: _('ITU-T G.984 class B+: the receiver operates from -28 to -8 dBm.') }, [
			E('div', { 'class': 'nj-trk' }, [
				zone(RX_LO, -28, 'rgba(229,72,77,.45)'), zone(-28, RX_OK_LO, 'rgba(240,160,32,.45)'),
				zone(RX_OK_LO, RX_OK_HI, 'rgba(47,191,113,.42)'), zone(RX_OK_HI, RX_HI, 'rgba(229,72,77,.45)') ]),
			this.mk,
			E('span', { 'class': 'nj-tk', style: 'left:' + pos(-28) }, [ '-28' ]),
			E('span', { 'class': 'nj-tk', style: 'left:' + pos(-8) }, [ '-8 dBm' ])
		]));
		R.traffic.node.setAttribute('title', _('Counters of the Linux interface. Flows offloaded to the hardware NAT may not be counted.'));

		this.art = drawing(String(board.model || 'NijikaWrt').replace(/^D-Link\s+/, ''));
		this.sn = E('span', { 'class': 'nj-sn' });
		this.det = E('div', { 'class': 'nj-det' });
		this.wrap = E('div', { 'class': 'nj-w' }, [ E('style', {}, CSS), nc.style(), E('div', { 'class': 'nj' }, [
			E('div', { 'class': 'nj-art' }, [ this.art ]),
			E('div', { 'class': 'nj-vals' }, [ R.state.node, R.rx.node, R.tx.node, R.temp.node, R.wan.node, R.traffic.node ]),
			E('div', { 'class': 'nj-foot' }, [
				E('span', { 'class': 'nj-brand' }, [
					/* DISTRIB_DESCRIPTION: "NijikaWrt r47 / OpenWrt 25.12.5 r..." */
					E('b', {}, [ String((board.release || {}).description || 'NijikaWrt').split(' / ')[0] ]), '·',
					E('a', { href: L.url('admin/nijika/status') }, [ _('ONT Status') + ' ›' ]), '·',
					E('a', { href: L.url('admin/nijika/provision') }, [ _('OLT Provision') + ' ›' ]), '·',
					E('a', { href: L.url('admin/network/ponwan') }, [ _('PON WAN') + ' ›' ]) ]),
				this.sn ]),
			this.det ]) ]);
	},

	led: function(name, cls) {
		var n = this.art.querySelector('[data-led="' + name + '"]');
		if (n)
			n.setAttribute('class', 'ng-led' + (cls ? ' ' + cls : ''));
	},

	put: function(r, lvl, text, sub) {
		r.dot.className = 'nj-dot' + (lvl ? '' : ' none');
		r.dot.style.setProperty('--nj-c', lvl ? COL[lvl] : 'transparent');
		r.dot.style.setProperty('--nj-h', lvl ? HALO[lvl] : 'transparent');
		r.val.replaceChildren(text);
		if (sub !== undefined)
			r.sub.textContent = sub || ' ';
	},

	/* the rate between two readings of the byte counters of one interface */
	rates: function(ifname, dev) {
		var stats = (dev && dev.stats) || {};
		var rxb = Number(stats.rx_bytes), txb = Number(stats.tx_bytes), t = Date.now() / 1000, p = this.prev;

		if (!isFinite(rxb) || !isFinite(txb) || !ifname) {
			this.prev = this.rx = this.tx = null;
			return;
		}
		if (p && p.ifname == ifname && t > p.t && rxb >= p.rx && txb >= p.tx) {
			this.rx = (rxb - p.rx) * 8 / (t - p.t);
			this.tx = (txb - p.tx) * 8 / (t - p.t);
		}
		else if (!p || p.ifname != ifname) {
			this.rx = this.tx = null;
		}
		this.prev = { ifname: ifname, t: t, rx: rxb, tx: txb };
	},

	update: function(st, wans, devs) {
		var R = this.rows, self = this;
		var los = !!st.los, rx = parseFloat(st.rx_dbm), tx = parseFloat(st.tx_dbm), temp = parseFloat(st.temp_c);
		var o5 = /^O5/.test(st.state || ''), key = (st.state || '').substr(0, 2);
		var hasRx = !los && !isNaN(rx), hasTx = !isNaN(tx);

		/* ONU state */
		this.put(R.state, los ? 'err' : (o5 ? 'ok' : (/^O7/.test(st.state || '') || !st.state ? 'err' : 'warn')),
			los ? _('Loss of signal') : (st.state || _('unknown')),
			los ? (st.state || '') : (nc.STATE_TEXT[key] || ''));

		/* RX power */
		var rl = hasRx ? level(rx, RX_OK_LO, RX_OK_HI, 1) : 'err';
		this.put(R.rx, rl, hasRx ? '%.1f dBm'.format(rx) : _('no light'));
		if (hasRx) {
			this.mk.removeAttribute('hidden');
			this.mk.style.left = pos(rx);
			this.mk.style.setProperty('--nj-c', COL[rl]);
		}
		else {
			this.mk.setAttribute('hidden', 'hidden');
		}

		/* TX power */
		this.put(R.tx, hasTx ? level(tx, 0.5, 5, 1) : null, hasTx ? '%.1f dBm'.format(tx) : _('off'),
			hasTx ? '1310 nm' + (st.bias_ma ? ', %s mA'.format(st.bias_ma) : '') : '');

		/* temperature of the BOSA */
		this.put(R.temp, isNaN(temp) ? null : (temp > 85 ? 'err' : (temp > 70 ? 'warn' : 'ok')),
			isNaN(temp) ? '-' : '%.1f °C'.format(temp), _('BOSA'));

		/* the WAN connection of the default route */
		var w = nc.wanDefault(wans);
		if (w)
			this.put(R.wan, 'ok', w.ip4 || w.ip6, '%s%s'.format(nc.wanMode(w), w.vid ? ', VLAN ' + w.vid : ''));
		else
			this.put(R.wan, wans.length ? 'err' : null, _('No connection'), wans.length ? '' : _('No WAN connection in the stock configuration.'));

		/* traffic of that connection */
		var ifname = w ? w.ifname : null;
		this.rates(ifname, ifname ? devs[ifname] : null);
		this.put(R.traffic, null, E('span', {}, [ E('span', { 'class': 'nj-ds' }, [ '↓ ' ]), rate(this.rx), '  ',
			E('span', { 'class': 'nj-us' }, [ '↑ ' ]), rate(this.tx) ]),
			ifname ? _('%s interface counters').format(ifname) : '');

		/* the drawing */
		this.art.setAttribute('data-light', hasRx ? '1' : '0');
		this.art.setAttribute('data-tx', (hasRx && hasTx) ? '1' : '0');
		this.led('PON', los ? null : (o5 ? 'ok' : 'warn'));
		this.led('LOS', los ? 'err' : null);
		this.led('WAN', w ? 'ok' : null);

		/* footer and details */
		this.sn.textContent = st.sn ? _('GPON SN %s').format(st.sn) : '';
		var details = [];
		/* vendor id of ME 131; some OLTs (and OLT sticks) send none */
		if (/[A-Za-z0-9]{2}/.test(st.olt_vendor || ''))
			details.push(_('OLT vendor %s').format(st.olt_vendor));
		if (st.voltage_v)
			details.push(_('Supply %s V').format(st.voltage_v));
		(st.alarms || []).forEach(function(a) {
			if (a.status == 'yes')
				details.push(_('Alarm: %s').format(a.name));
		});
		this.det.replaceChildren.apply(this.det, details.map(function(t) { return E('span', {}, [ t ]); }));
	}
};

return baseclass.extend({
	title: _('Fibre (GPON)'),

	load: function() {
		return Promise.all([
			L.resolveDefault(nc.callStatus(), {}),
			nc.wanStatus(),
			nc.netDevices(),
			card.wrap ? null : L.resolveDefault(callBoard(), {})
		]);
	},

	render: function(data) {
		var st = data[0] || {};
		if (st.error)
			return E('em', {}, st.error);

		if (!card.wrap)
			card.build(data[3] || {});
		card.update(st, data[1] || [], data[2] || {});
		/* the same node every poll, inserted only when not in the page yet */
		return card.wrap.isConnected ? null : card.wrap;
	}
});
