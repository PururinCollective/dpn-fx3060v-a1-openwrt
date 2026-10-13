'use strict';
'require view';
'require dom';
'require ui';
'require nijika.common as nc';

/*
 * Provisioning: what the OLT set up over OMCI, drawn the way traffic flows.
 *
 *   T-CONT (262) <- GEM port (268) <- GEM IW TP (266) / multicast IW (281)
 *     <- 802.1p mapper (130) <- bridge port, ANI side (47) + VLAN filter (84)
 *     <- MAC bridge (45) -> bridge port, UNI side (47)
 *     -> LAN port (11 PPTP Ethernet UNI) / VEIP (329) + VLAN rules (171)
 *
 * QoS comes from omci_app's own queue map (`omcicli dump qmap`): GEM port ->
 * priority queue -> T-CONT / Alloc-ID. Backend: rpcd nijika.provision.
 */

/* ---------------------------------------------------------------- model */

function hexId(v) {
	v = String(v == null ? '' : v).trim().replace(/^0x/i, '');
	return /^[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : NaN;
}

function hex4(n) {
	return isNaN(n) ? '?' : '0x' + ('000' + n.toString(16)).slice(-4);
}

function A(inst, key) {
	return nc.attr(inst, key);
}

function insts(me, cls) {
	return (me[cls] && me[cls].instances) || [];
}

var TP_TYPES = {
	1: _('LAN port'), 3: _('802.1p mapper'), 4: _('IP host'), 5: _('GEM interworking'),
	6: _('multicast GEM'), 11: 'VEIP'
};

var IW_OPT = {
	0: _('circuit emulation'), 1: _('MAC bridged LAN'), 3: _('IP data'), 5: _('802.1p mapper'),
	6: _('downstream broadcast')
};

function buildModel(d) {
	var me = d.me || {}, m = {
		tcont: {}, gem: {}, gemByPort: {}, iw: {}, mciw: {}, mapper: {}, bport: {}, bridge: {},
		filter: {}, ext: [], lan: {}, veip: {}, qmap: d.qmap || {}, issues: []
	};

	insts(me, 262).forEach(function(i) {
		var id = hexId(A(i, 'EntityID')), al = hexId(A(i, 'AllocID'));
		m.tcont[id] = { id: id, alloc: al, used: !(isNaN(al) || al == 0xff || al == 0xffff),
			policy: +A(i, 'Policy') };
	});
	insts(me, 268).forEach(function(i) {
		var g = { id: hexId(A(i, 'EntityId')), port: nc.toInt(A(i, 'PortID')),
			tcont: hexId(A(i, 'TcAdapterPtr')), dir: +A(i, 'Direction'),
			usq: hexId(A(i, 'UsTraffMgmtPtr')), usTd: hexId(A(i, 'UsTraffDescPtr')),
			dsTd: hexId(A(i, 'DsTraffDescPtr')) };
		m.gem[g.id] = g;
		m.gemByPort[g.port] = g;
	});
	insts(me, 266).forEach(function(i) {
		var w = { id: hexId(A(i, 'EntityID')), gem: hexId(A(i, 'GemCtpPtr')), opt: +A(i, 'IwOpt'),
			svc: hexId(A(i, 'ServProPtr')) };
		m.iw[w.id] = w;
	});
	insts(me, 281).forEach(function(i) {
		var w = { id: hexId(A(i, 'EntityID')), gem: hexId(A(i, 'GemCtpPtr')) };
		m.mciw[w.id] = w;
	});
	insts(me, 130).forEach(function(i) {
		var mp = { id: hexId(A(i, 'EntityID')), pbit: [] };
		for (var p = 0; p < 8; p++)
			mp.pbit.push(hexId(A(i, 'IwTpPtrPbit' + p)));
		m.mapper[mp.id] = mp;
	});
	insts(me, 45).forEach(function(i) {
		var id = hexId(A(i, 'EntityID'));
		m.bridge[id] = { id: id, idx: A(i, 'BridgeIdx') };
	});
	insts(me, 47).forEach(function(i) {
		var b = { id: hexId(A(i, 'EntityID')), bridge: hexId(A(i, 'BridgeIdPtr')),
			num: +A(i, 'PortNum'), type: +A(i, 'TPType'), tp: hexId(A(i, 'TPPointer')) };
		b.uni = (b.type == 1 || b.type == 11 || b.type == 4);
		m.bport[b.id] = b;
	});
	insts(me, 84).forEach(function(i) {
		m.filter[hexId(A(i, 'EntityID'))] = { vids: nc.vtfdVids(i), op: A(i, 'FwdOp') };
	});
	insts(me, 11).forEach(function(i) {
		var id = hexId(A(i, 'EntityID'));
		m.lan[id] = { id: id, name: 'LAN' + (id & 0xff), up: A(i, 'OpState') == '0' };
	});
	insts(me, 329).forEach(function(i) {
		var id = hexId(A(i, 'EntityId'));
		m.veip[id] = { id: id, name: 'VEIP', up: A(i, 'OperState') != '1' };
	});
	insts(me, 171).forEach(function(i) {
		m.ext.push({ id: hexId(A(i, 'EntityId')), assoc: +A(i, 'AssociationType'),
			point: hexId(A(i, 'AssociatedMePoint')), ds: A(i, 'DsMode'), rules: nc.extVlanRules(i) });
	});

	/* the ONT port behind a UNI-side bridge port */
	m.portOf = function(bp) {
		if (bp.type == 1)
			return m.lan[bp.tp] || null;
		if (bp.type == 11) {
			if (m.veip[bp.tp])
				return m.veip[bp.tp];
			var ids = Object.keys(m.veip);
			return ids.length == 1 ? m.veip[ids[0]] : null;
		}
		return null;
	};

	/* VLAN rules (ME 171) that apply to an ONT port */
	m.extOf = function(port) {
		return m.ext.filter(function(x) {
			if (m.veip[port.id])
				return x.assoc == 10;
			return x.assoc == 2 && x.point == port.id;
		})[0] || null;
	};

	return m;
}

/* ------------------------------------------------- VLAN rules in words */

/* G.988 9.3.13: what the ONT does upstream with a frame carrying VID `vid`
 * (single tag), or an untagged frame (vid null). */
function ruleFor(ext, vid) {
	if (!ext || !ext.rules.length)
		return { kind: 'pass', text: _('as is'), title: _('no VLAN rules on this port') };

	var single = function(r) { return r.filterOuter && r.filterOuter.pri == '15'; },
	    match = null, dflt = null;

	ext.rules.forEach(function(r) {
		if (!r.filterInner || !single(r))
			return;
		var fi = r.filterInner;
		if (vid == null) {
			if (fi.pri == '15' && !match) match = r;
		}
		else if (fi.pri != '15' && fi.pri != '14' && +fi.vid == vid && !match) match = r;
		else if (fi.pri == '14' && !dflt) dflt = r;
	});

	var r = match || (vid != null ? dflt : null);
	if (!r)
		return { kind: 'pass', text: _('as is'), title: _('no rule matches: the frame passes unchanged') };

	var to = r.treatmentOuter || {}, ti = r.treatmentInner || {}, rm = +(to.rm || 0);
	if (rm == 3)
		return { kind: 'drop', text: _('drop'), title: match ? _('rule discards it') : _('default rule discards it') };

	var addInner = ti.pri && ti.pri != '15', addOuter = to.pri && to.pri != '15';
	var newVid = function(t) {
		return (t.vid == '4096') ? vid : (t.vid == '4097') ? vid : +t.vid;
	};

	if (vid == null) {
		if (addInner && !addOuter)
			return { kind: 'tag', vid: newVid(ti), text: _('tag VLAN %d').format(newVid(ti)),
				title: _('untagged frames get VLAN %d').format(newVid(ti)) };
		return { kind: 'pass', text: _('as is'), title: '' };
	}
	if (rm == 1 && addInner && !addOuter) {
		var nv = newVid(ti);
		return (nv == vid)
			? { kind: 'pass', text: _('as is'), title: _('tag removed and put back unchanged') }
			: { kind: 'xlate', vid: nv, text: _('→ VLAN %d').format(nv), title: _('VLAN translated') };
	}
	if (rm == 0 && addOuter)
		return { kind: 'stack', vid: newVid(to), text: _('+ outer VLAN %d').format(newVid(to)), title: _('double tagged (Q-in-Q)') };
	if (rm == 1 && !addInner && !addOuter)
		return { kind: 'strip', text: _('untag'), title: _('the tag is removed') };
	return { kind: 'pass', text: _('as is'), title: '' };
}

/* ------------------------------------------------------------- services */

function pbitText(list) {
	if (list.length == 8) return _('p-bits 0-7');
	return _('p-bits %s').format(list.join(','));
}

/* One entry per ANI-side bridge port: the GEM ports behind it. */
function aniPath(m, bp) {
	var p = { bp: bp, gems: [], kind: 'unicast', mapper: null };
	if (bp.type == 3 && m.mapper[bp.tp]) {
		var mp = m.mapper[bp.tp], seen = {};
		p.mapper = mp;
		mp.pbit.forEach(function(iwId, pb) {
			var iw = m.iw[iwId], g = iw && m.gem[iw.gem];
			if (!g) return;
			if (!seen[g.id]) { seen[g.id] = { gem: g, iw: iw, pbits: [] }; p.gems.push(seen[g.id]); }
			seen[g.id].pbits.push(pb);
		});
	}
	else if (bp.type == 5 && m.iw[bp.tp]) {
		var iw = m.iw[bp.tp], g = m.gem[iw.gem];
		if (g) p.gems.push({ gem: g, iw: iw, pbits: [] });
		if (iw.opt == 6 || (g && g.dir == 2)) p.kind = 'broadcast';
	}
	else if (bp.type == 6 && m.mciw[bp.tp]) {
		var mw = m.mciw[bp.tp], mg = m.gem[mw.gem];
		if (mg) p.gems.push({ gem: mg, iw: mw, pbits: [] });
		p.kind = 'multicast';
	}
	return p;
}

function buildServices(m, wans) {
	var out = [], bridgesWithAni = {};

	Object.keys(m.bridge).forEach(function(bid) {
		var ports = Object.values(m.bport).filter(function(b) { return b.bridge == bid; }),
		    unis = ports.filter(function(b) { return b.uni; }),
		    anis = ports.filter(function(b) { return !b.uni; }).map(function(b) { return aniPath(m, b); }),
		    bcast = anis.filter(function(a) { return a.kind == 'broadcast'; });

		unis.forEach(function(u) {
			var port = m.portOf(u), ext = port && m.extOf(port);
			var uc = anis.filter(function(a) { return a.kind == 'unicast'; });
			if (!uc.length) {
				out.push({ bridge: +bid, uni: u, port: port, none: true });
				return;
			}
			bridgesWithAni[bid] = true;
			uc.forEach(function(a) {
				var vids = (m.filter[a.bp.id] || {}).vids || [];
				(vids.length ? vids : [ null ]).forEach(function(vid) {
					var bc = bcast.filter(function(b) {
						var bv = (m.filter[b.bp.id] || {}).vids || [];
						return vid == null || !bv.length || bv.indexOf(vid) >= 0;
					});
					out.push({
						bridge: +bid, uni: u, port: port, ext: ext, vid: vid, ani: a,
						rule: (vid != null) ? ruleFor(ext, vid) : { kind: 'pass', text: _('as is'), title: '' },
						bcast: bc, wan: (port && m.veip[port.id] && vid != null) ? wans[vid] : null
					});
				});
			});
		});
	});

	var rank = function(s) { return s.none ? 2 : (s.port && m.veip[s.port.id]) ? 0 : 1; };
	out = out.map(function(s, i) { s.i = i; return s; }).sort(function(a, b) { return (rank(a) - rank(b)) || (a.i - b.i); });
	var none = out.filter(function(s) { return s.none; });
	out = out.filter(function(s) { return !s.none; });
	if (none.length) out.push({ none: true, ports: none });

	/* untagged frames that a rule tags into a provisioned VLAN */
	out.forEach(function(s) {
		if (s.none || s.vid == null || !s.ext) return;
		var u = ruleFor(s.ext, null);
		if (u.kind == 'tag' && u.vid == s.vid) s.untagged = true;
	});
	return out;
}

/* ------------------------------------------------------- graph drawing */

var SVGNS = 'http://www.w3.org/2000/svg';

function node(id, title, sub, chips, cls) {
	return { id: id, title: title, sub: sub, chips: chips || [], cls: cls || '' };
}

/* cols: [{ title, nodes: [node] }], links: [{ a, b, label, cls }] */
function graph(cols, links) {
	var svg = document.createElementNS(SVGNS, 'svg');
	svg.setAttribute('class', 'nj-wires');
	var grid = E('div', { 'class': 'nj-cols', 'style': 'grid-template-columns:repeat(%d,minmax(8.5em,1fr))'.format(cols.length) },
		cols.map(function(c) {
			return E('div', { 'class': 'nj-col' }, [ E('div', { 'class': 'nj-col-h' }, c.title) ].concat(
				c.nodes.length ? c.nodes.map(function(n) {
					return E('div', { 'class': 'nj-node ' + n.cls, 'data-id': n.id }, [
						E('div', { 'class': 'nj-t' }, n.title),
						n.sub ? E('div', { 'class': 'nj-s' }, n.sub) : ''
					].concat(n.chips.map(function(ch) {
						return E('div', { 'class': 'nj-chip ' + (ch.cls || ''), 'title': ch.title || '' }, ch.text);
					})));
				}) : [ E('div', { 'class': 'nj-empty' }, '-') ]));
		}));
	var wrap = E('div', { 'class': 'nj-graph' }, [ svg, grid ]);

	/* coordinates inside the (scrollable) graph box */
	function center(el, side, base) {
		var r = el.getBoundingClientRect();
		return { x: (side == 'r' ? r.right : r.left) - base.left + wrap.scrollLeft,
		         y: r.top + r.height / 2 - base.top + wrap.scrollTop };
	}

	function draw() {
		if (!wrap.isConnected) return;
		while (svg.firstChild) svg.removeChild(svg.firstChild);
		svg.setAttribute('width', 0);
		svg.setAttribute('height', 0);
		var base = wrap.getBoundingClientRect();
		svg.setAttribute('width', grid.offsetLeft + grid.offsetWidth);
		svg.setAttribute('height', grid.offsetTop + grid.offsetHeight);
		links.forEach(function(l) {
			var a = wrap.querySelector('[data-id="%s"]'.format(l.a)), b = wrap.querySelector('[data-id="%s"]'.format(l.b));
			if (!a || !b) return;
			var p = center(a, 'r', base), q = center(b, 'l', base);
			if (q.x < p.x) { p = center(b, 'r', base); q = center(a, 'l', base); }
			var dx = Math.max(20, (q.x - p.x) / 2);
			var path = document.createElementNS(SVGNS, 'path');
			path.setAttribute('d', 'M%f %f C%f %f %f %f %f %f'.format(p.x, p.y, p.x + dx, p.y, q.x - dx, q.y, q.x, q.y));
			path.setAttribute('class', 'nj-wire ' + (l.cls || ''));
			svg.appendChild(path);
			if (l.label) {
				var t = document.createElementNS(SVGNS, 'text');
				t.setAttribute('x', p.x + 6);
				t.setAttribute('y', p.y - 4);
				t.setAttribute('class', 'nj-wire-label');
				t.textContent = l.label;
				svg.appendChild(t);
			}
		});
	}

	requestAnimationFrame(function() { requestAnimationFrame(draw); });
	window.addEventListener('resize', draw);
	if (window.ResizeObserver)
		new ResizeObserver(draw).observe(wrap);
	return wrap;
}

/* order nodes along the paths so wires cross as little as possible */
function ordered(map, order) {
	return Object.keys(map).sort(function(x, y) {
		var ox = order[x] != null ? order[x] : 1e6, oy = order[y] != null ? order[y] : 1e6;
		return (ox - oy) || (+x - +y);
	}).map(function(k) { return map[k]; });
}

/* ------------------------------------------------------------- sections */

var SERVICE_NAMES = [ [ 2, _('Internet') ], [ 8, _('Voice') ], [ 4, _('Other/IPTV') ], [ 1, 'TR-069' ] ];

/* stock WAN connections (ATM_VC_TBL) by VLAN: "PON_0: Internet (PPPoE)" */
function wanNames(chain) {
	var out = {};
	((chain && chain.records) || []).forEach(function(r, i) {
		if (r.vlan != '1' || !r.vid) return;
		var t = +r.applicationtype || 0,
		    svc = SERVICE_NAMES.filter(function(s) { return t & s[0]; }).map(function(s) { return s[1]; }).join(' + ') || _('no service'),
		    mode = { 0: _('Bridge'), 1: 'IPoE', 2: 'PPPoE' }[r.ChannelMode] || '';
		out[+r.vid] = { idx: i, text: 'PON_%d: %s%s'.format(i, svc, mode ? ' (' + mode + ')' : '') };
	});
	return out;
}

function portName(m, s) {
	if (s.port) return s.port.name;
	return _('bridge port %s').format(hex4(s.uni.id));
}

function renderIdentity(d) {
	var o = insts(d.me, 131)[0], t = insts(d.me, 256)[0];
	var olt = o ? A(o, 'OltVendorId') : null, oltTxt = olt ? (nc.hexToAscii(olt) || olt) : '-';
	var tm = t ? { 0: _('priority controlled'), 1: _('rate controlled'), 2: _('priority and rate controlled') }[A(t, 'TraffMgtOpt')] : null;
	var eq = o ? (nc.hexToAscii(A(o, 'EquipId')) || String(A(o, 'EquipId') || '').trim()) : '';
	var ver = o ? (nc.hexToAscii(A(o, 'Version')) || A(o, 'Version')) : '';
	return E('div', { 'class': 'nj-cards' }, [
		E('div', { 'class': 'nj-card' }, [
			E('div', { 'class': 'nj-card-h' }, _('Your provider (ME 131 OLT-G)')),
			E('div', { 'class': 'nj-big' }, oltTxt),
			E('div', { 'class': 'nj-s' }, [ eq || _('no equipment ID'), ' · ', (ver && ver != '0') ? ver : _('no version') ])
		]),
		E('div', { 'class': 'nj-card' }, [
			E('div', { 'class': 'nj-card-h' }, _('This ONT (ME 256 ONT-G)')),
			E('div', { 'class': 'nj-big' }, t ? '%s %s'.format(A(t, 'VID') || '', A(t, 'Version') || '') : '-'),
			E('div', { 'class': 'nj-s' }, t ? [ String(A(t, 'SerialNum') || '').toUpperCase(), ' · ', tm || '' ] : '')
		])
	]);
}

function renderServices(m, svcs) {
	var rows = [];
	svcs.forEach(function(s) {
		if (s.none) {
			rows.push(E('div', { 'class': 'nj-svc none' }, [
				E('div', { 'class': 'nj-svc-h' }, [ s.ports.map(function(p) { return portName(m, p); }).join(', '),
					E('span', { 'class': 'nj-s' }, ' · ' + _('no service')) ]),
				E('div', { 'class': 'nj-s' }, _('The OLT bridged these ports but gave them no path to the fibre: nothing they send leaves the ONT.'))
			]));
			return;
		}
		var g = s.ani.gems.map(function(x) { return x.gem; }),
		    tc = g.map(function(x) { return m.tcont[x.tcont]; }).filter(function(x) { return x && x.used; }),
		    vidTxt = s.vid != null ? 'VLAN ' + s.vid : _('any VLAN'),
		    side = (s.port && m.veip[s.port.id]) ? _('Router (stock WAN)') : portName(m, s),
		    dir = g.length && g.every(function(x) { return x.dir == 2; }) ? _('downstream only') : _('both ways');

		var title = [ vidTxt ];
		if (s.wan) title.push(E('span', { 'class': 'nj-wan' }, s.wan.text));

		var line = E('div', { 'class': 'nj-line' }, [
			E('span', { 'class': 'nj-end' }, side),
			E('span', { 'class': 'nj-wire-h' }),
			E('span', { 'class': 'nj-pill' }, s.untagged ? _('untagged') : vidTxt),
			E('span', { 'class': 'nj-wire-h' }),
			E('span', { 'class': 'nj-pill rule ' + s.rule.kind, 'title': s.rule.title || '' },
				s.untagged ? _('tag VLAN %d').format(s.vid) : s.rule.text),
			E('span', { 'class': 'nj-wire-h' }),
			E('span', { 'class': 'nj-pill' }, s.rule.kind == 'drop' ? '✕' : vidTxt),
			E('span', { 'class': 'nj-wire-h' }),
			E('span', { 'class': 'nj-end' }, _('OLT'))
		]);

		var words = [];
		if (s.rule.kind == 'drop')
			words.push(_('The VLAN is provisioned on the fibre side, but this port\'s VLAN rules discard it.'));
		else if (s.untagged)
			words.push(_('Send it untagged; the ONT adds VLAN %d.').format(s.vid));
		else if (s.vid != null)
			words.push(_('%s must send VLAN %d; the ONT passes it %s.').format(side, s.vid, s.rule.kind == 'pass' ? _('unchanged') : s.rule.text));
		words.push(_('GEM port %s → T-CONT %s, %s.').format(
			g.map(function(x) { return x.port; }).join(', ') || '-',
			tc.map(function(x) { return _('Alloc-ID %d').format(x.alloc); }).join(', ') || '-', dir));
		if (s.bcast.length)
			words.push(_('Downstream broadcast also arrives on GEM %s.').format(
				s.bcast.map(function(b) { return b.gems.map(function(x) { return x.gem.port; }).join(','); }).join(', ')));

		rows.push(E('div', { 'class': 'nj-svc ' + s.rule.kind }, [
			E('div', { 'class': 'nj-svc-h' }, [ title[0], ' ', E('span', { 'class': 'nj-s' }, '· ' + portName(m, s)), ' ' ].concat(title.slice(1))),
			line,
			E('div', { 'class': 'nj-s' }, words.join(' '))
		]));
	});

	/* multicast */
	Object.values(m.mciw).forEach(function(w) {
		var g = m.gem[w.gem];
		rows.push(E('div', { 'class': 'nj-svc mcast' }, [
			E('div', { 'class': 'nj-svc-h' }, _('Multicast (usually IPTV)')),
			E('div', { 'class': 'nj-s' }, _('Multicast GEM port %s, downstream only.').format(g ? g.port : hex4(w.gem)))
		]));
	});

	return rows.length ? E('div', {}, rows) : E('em', {}, _('No service provisioned (the OLT has not set up a data path yet).'));
}

/* Upstream rules per port, as a table: what is passed, changed or dropped. */
function renderRules(m) {
	var rows = [];
	m.ext.forEach(function(x) {
		var port = m.veip[x.point] || m.lan[x.point] || (x.assoc == 10 ? Object.values(m.veip)[0] : null);
		var name = port ? port.name : nc.uniLabel(x.assoc, hex4(x.point));
		x.rules.forEach(function(r) {
			var fi = r.filterInner || {}, fo = r.filterOuter || {}, to = r.treatmentOuter || {}, ti = r.treatmentInner || {};
			var match;
			if (fo.pri == '15' && fi.pri == '15') match = _('untagged');
			else if (fo.pri == '15' && fi.pri == '14') match = _('any other single-tagged');
			else if (fo.pri == '14' && fi.pri == '14') match = _('any double-tagged');
			else if (fo.pri == '15') match = 'VLAN ' + (fi.vid == '4096' ? _('any') : fi.vid) + (fi.pri != '8' ? ' p' + fi.pri : '');
			else match = _('outer %s, inner %s').format(nc.fmtFilter(fo), nc.fmtFilter(fi));

			var act;
			if (+(to.rm || 0) == 3) act = E('span', { 'class': 'nj-drop' }, _('drop'));
			else {
				var parts = [];
				if (+(to.rm || 0) > 0) parts.push(_('remove %s tag(s)').format(to.rm));
				if (to.pri && to.pri != '15') parts.push(_('add outer %s').format(nc.fmtTreat(to)));
				if (ti.pri && ti.pri != '15') parts.push(_('add %s').format(nc.fmtTreat(ti)));
				var same = (+(to.rm || 0) == 1) && ti.pri && ti.pri != '15' && (ti.vid == fi.vid || ti.vid == '4096') && !(to.pri && to.pri != '15');
				act = same ? E('span', { 'class': 'nj-pass' }, _('pass as is')) : (parts.join(', ') || _('pass as is'));
			}
			rows.push([ name, match, act ]);
		});
		rows.push([ name, E('em', {}, _('downstream')), x.ds == '0' ? _('the inverse of the rules above') : _('frames pass as they are') ]);
	});
	return E('table', { 'class': 'table nj-rules' }, [
		E('tr', { 'class': 'tr table-titles' }, [ _('Port'), _('Frames from the port'), _('ONT does') ].map(function(h) { return E('th', { 'class': 'th left' }, h); }))
	].concat(rows.length ? rows.map(function(r) {
		return E('tr', { 'class': 'tr' }, r.map(function(c) { return E('td', { 'class': 'td left' }, c); }));
	}) : [ E('tr', { 'class': 'tr placeholder' }, E('td', { 'class': 'td', 'colspan': 3 }, E('em', {}, _('No VLAN rules (ME 171) provisioned')))) ]));
}

function renderSetup(m) {
	var order = {}, n = 0, links = [];
	var cTcont = {}, cGem = {}, cMap = {}, cAni = {}, cBr = {}, cUni = {}, cPort = {};
	var mark = function(k) { if (order[k] == null) order[k] = n++; };

	Object.keys(m.bridge).forEach(function(bid) {
		var ports = Object.values(m.bport).filter(function(b) { return b.bridge == bid; });
		ports.filter(function(b) { return !b.uni; }).forEach(function(b) {
			var a = aniPath(m, b), f = m.filter[b.id], vids = f ? f.vids : [];
			mark('b' + b.id); mark('br' + bid);
			cAni[b.id] = node('ani' + b.id, hex4(b.id), (a.mapper ? _('→ mapper %s') : _('→ %s')).format(a.mapper ? hex4(a.mapper.id) : (TP_TYPES[b.type] || b.type)),
				[ { text: vids.length ? _('VLAN filter: %s').format(vids.join(', ')) : _('no VLAN filter'), cls: vids.length ? 'olt' : 'warn' } ],
				a.kind != 'unicast' ? 'ds' : '');
			links.push({ a: 'ani' + b.id, b: 'br' + bid });
			if (a.mapper) {
				var mp = a.mapper;
				mark('m' + mp.id);
				cMap[mp.id] = node('map' + mp.id, hex4(mp.id), a.gems.map(function(x) { return pbitText(x.pbits) + ' → GEM ' + x.gem.port; }).join('; '));
				links.push({ a: 'map' + mp.id, b: 'ani' + b.id });
			}
			a.gems.forEach(function(x) {
				var g = x.gem;
				mark('g' + g.id);
				cGem[g.id] = node('gem' + g.id, 'GEM ' + g.port, hex4(g.id) + ' · ' + ({ 1: _('upstream'), 2: _('downstream'), 3: _('both ways') }[g.dir] || ''),
					[ { text: (x.iw && IW_OPT[x.iw.opt] != null) ? 'IW ' + hex4(x.iw.id) + ' · ' + IW_OPT[x.iw.opt] : (a.kind == 'multicast' ? _('multicast IW') : 'IW') } ],
					g.dir == 2 ? 'ds' : '');
				links.push({ a: 'gem' + g.id, b: a.mapper ? 'map' + a.mapper.id : 'ani' + b.id,
					label: (a.mapper && x.pbits.length < 8) ? pbitText(x.pbits) : '', cls: g.dir == 2 ? 'ds' : '' });
				var t = m.tcont[g.tcont];
				if (t && t.used) {
					mark('t' + t.id);
					cTcont[t.id] = node('tc' + t.id, _('Alloc-ID %d').format(t.alloc), hex4(t.id) + ' · ' + ({ 0: _('no policy'), 1: _('strict priority'), 2: 'WRR' }[t.policy] || ''));
					links.push({ a: 'tc' + t.id, b: 'gem' + g.id });
				}
			});
		});
		var hasUni = false;
		ports.filter(function(b) { return b.uni; }).forEach(function(b) {
			var port = m.portOf(b);
			hasUni = true;
			mark('u' + b.id);
			cUni[b.id] = node('uni' + b.id, hex4(b.id), '→ %s %s'.format(TP_TYPES[b.type] || b.type, hex4(b.tp)),
				(b.type == 11 && port && port.id != b.tp) ? [ { text: _('points to %s, VEIP is %s').format(hex4(b.tp), hex4(port.id)), cls: 'warn',
					title: _('The OLT addressed the VEIP by another ID; the stock stack maps it anyway.') } ] : []);
			links.push({ a: 'br' + bid, b: 'uni' + b.id });
			if (port) {
				var ext = m.extOf(port);
				mark('p' + port.id);
				cPort[port.id] = node('port' + port.id, port.name, hex4(port.id) + (port.up ? ' · ' + _('link up') : ''),
					[ { text: ext ? _('VLAN rules: %d').format(ext.rules.length) : _('no VLAN rules'), cls: ext ? 'olt' : '' } ],
					m.veip[port.id] ? 'veip' : '');
				links.push({ a: 'uni' + b.id, b: 'port' + port.id });
			}
		});
		cBr[bid] = node('br' + bid, _('Bridge %s').format(hex4(+bid)), ports.length + ' ' + _('ports'), [], hasUni ? '' : 'warn');
	});

	var col = function(map, key) {
		var o = {};
		Object.keys(map).forEach(function(k) { o[k] = order[key + k]; });
		return ordered(map, o);
	};
	return graph([
		{ title: _('T-CONTs'), nodes: col(cTcont, 't') },
		{ title: _('GEM ports'), nodes: col(cGem, 'g') },
		{ title: _('802.1p mappers'), nodes: col(cMap, 'm') },
		{ title: _('Bridge ports (fibre side)'), nodes: col(cAni, 'b') },
		{ title: _('MAC bridges'), nodes: col(cBr, 'br') },
		{ title: _('Bridge ports (ONT side)'), nodes: col(cUni, 'u') },
		{ title: _('ONT ports'), nodes: col(cPort, 'p') }
	], links);
}

function renderQos(m, svcs) {
	var q = m.qmap || {}, links = [], order = {}, n = 0;
	var cSvc = {}, cGem = {}, cQ = {}, cT = {};
	var tcByTcid = {}, pqById = {};
	(q.tcont || []).forEach(function(t) { tcByTcid[t.tcid] = t; });
	(q.pq || []).forEach(function(p) { pqById[hexId(p.meid)] = p; });

	svcs.forEach(function(s, i) {
		if (s.none || !s.ani) return;
		var id = 's' + i;
		cSvc[id] = node(id, s.vid != null ? 'VLAN ' + s.vid : _('any VLAN'), portName(m, s) + (s.wan ? ' · ' + s.wan.text : ''));
		order[id] = n++;
		s.ani.gems.forEach(function(x) {
			links.push({ a: id, b: 'qg' + x.gem.port, label: (x.pbits.length && x.pbits.length < 8) ? pbitText(x.pbits) : '' });
		});
	});

	var gems = Object.values(m.gem).sort(function(a, b) { return a.port - b.port; });
	gems.forEach(function(g) {
		var us = (q.us || []).filter(function(f) { return f.gem == g.port; })[0];
		var pqId = us ? hexId(us.pq) : g.usq;
		var chips = [];
		if (!isNaN(g.usTd) && g.usTd) chips.push({ text: _('upstream limit: ME 280 %s').format(hex4(g.usTd)), cls: 'warn' });
		if (!isNaN(g.dsTd) && g.dsTd) chips.push({ text: _('downstream limit: ME 280 %s').format(hex4(g.dsTd)), cls: 'warn' });
		cGem['qg' + g.port] = node('qg' + g.port, 'GEM ' + g.port,
			g.dir == 2 ? (m.mciw && Object.values(m.mciw).some(function(w) { return w.gem == g.id; }) ? _('multicast, downstream only') : _('downstream only')) : _('both ways'),
			chips, g.dir == 2 ? 'ds' : '');
		if (g.dir != 2 && !isNaN(pqId) && pqId) {
			var p = pqById[pqId];
			var key = 'qq' + pqId;
			if (!cQ[key]) {
				var w = p ? (p.policy == 'WRR' ? _('weight %d').format(p.pw) : _('priority %d').format(p.pw)) : '';
				var rate = [];
				if (p && p.cir) rate.push(_('CIR %d kbit/s').format(p.cir * 8));
				if (p && p.pir) rate.push(_('PIR %d kbit/s').format(p.pir * 8));
				cQ[key] = node(key, _('Queue %s').format(hex4(pqId)), p ? '%s · %s'.format(p.policy, w) : _('not in the queue map'),
					rate.map(function(r) { return { text: r, cls: 'warn' }; }));
			}
			links.push({ a: 'qg' + g.port, b: key });
			var t = p ? tcByTcid[p.tcid] : null;
			if (t) {
				var tk = 'qt' + t.tcid;
				cT[tk] = node(tk, _('T-CONT %d').format(t.tcid), _('Alloc-ID %d · %s').format(t.alloc, hex4(hexId(t.meid))));
				links.push({ a: key, b: tk });
			}
		}
	});

	/* order GEMs / queues / T-CONTs after the services that use them */
	links.forEach(function(l) {
		if (order[l.b] == null && order[l.a] != null) order[l.b] = order[l.a];
	});
	links.forEach(function(l) {
		if (order[l.b] == null && order[l.a] != null) order[l.b] = order[l.a];
	});
	var col = function(map) { return ordered(map, order); };

	var limits = gems.filter(function(g) { return (!isNaN(g.usTd) && g.usTd) || (!isNaN(g.dsTd) && g.dsTd); }).length +
		(q.pq || []).filter(function(p) { return p.cir || p.pir; }).length;
	return E('div', {}, [
		E('div', { 'class': 'nj-tags' }, [
			E('span', { 'class': 'nj-tag' }, _('GEM ports: %d').format(gems.length)),
			E('span', { 'class': 'nj-tag' }, _('T-CONTs with an Alloc-ID: %d').format((q.tcont || []).length)),
			E('span', { 'class': 'nj-tag' }, _('Queues in use: %d').format((q.pq || []).length)),
			E('span', { 'class': 'nj-tag' }, _('Rate limits: %d').format(limits))
		]),
		graph([
			{ title: _('Services'), nodes: col(cSvc) },
			{ title: _('GEM ports'), nodes: col(cGem) },
			{ title: _('Priority queues'), nodes: col(cQ) },
			{ title: _('T-CONTs'), nodes: col(cT) }
		], links),
		E('p', { 'class': 'nj-s' }, _('Upstream: the p-bits pick the GEM port, it waits in its priority queue, and the T-CONT sends when the OLT grants its Alloc-ID time. Rate limits shown here are the ones set on the ONT; your plan\'s speed is enforced in the OLT.'))
	]);
}

function findIssues(m, svcs, wans) {
	var out = [];
	Object.values(m.bport).forEach(function(b) {
		var ok = (b.type == 1 && m.lan[b.tp]) || (b.type == 3 && m.mapper[b.tp]) || (b.type == 5 && m.iw[b.tp]) ||
			(b.type == 6 && m.mciw[b.tp]) || (b.type == 11 && m.veip[b.tp]) || b.type == 4;
		if (!ok)
			out.push([ 'info', _('Bridge port %s points to %s %s, which is not in the MIB%s.').format(hex4(b.id), TP_TYPES[b.type] || ('type ' + b.type), hex4(b.tp),
				(b.type == 11 && Object.keys(m.veip).length) ? _(' (the VEIP is %s; the stock stack maps it anyway)').format(hex4(+Object.keys(m.veip)[0])) : '') ]);
	});
	Object.values(m.gem).forEach(function(g) {
		if (g.dir != 2 && !(m.tcont[g.tcont] && m.tcont[g.tcont].used))
			out.push([ 'warn', _('GEM port %d sends upstream but its T-CONT %s has no Alloc-ID.').format(g.port, hex4(g.tcont)) ]);
	});
	var provisioned = {};
	svcs.forEach(function(s) { if (s.vid != null && s.port && m.veip[s.port.id] && s.rule.kind != 'drop') provisioned[s.vid] = true; });
	if (Object.keys(m.veip).length && svcs.length)
		Object.keys(wans).forEach(function(v) {
			if (!provisioned[v])
				out.push([ 'info', _('Stock WAN %s (VLAN %s) has no path from the OLT, so it stays down. That is normal when your plan does not include this service (e.g. a legacy IPTV VLAN).').format(wans[v].text, v) ]);
		});
	svcs.forEach(function(s) {
		if (s.rule && s.rule.kind == 'drop')
			out.push([ 'warn', _('VLAN %d reaches %s from the fibre, but its VLAN rules drop it.').format(s.vid, portName(m, s)) ]);
	});
	return out;
}

var CSS = '\
.nj-cards{display:flex;flex-wrap:wrap;gap:1em;margin:.5em 0 1em}\
.nj-card{flex:1 1 16em;border:1px solid rgba(127,127,127,.3);border-radius:.5em;padding:.7em 1em;background:rgba(127,127,127,.06)}\
.nj-card-h{font-size:.85em;opacity:.75}.nj-big{font-size:1.4em;font-weight:bold;margin:.15em 0}\
.nj-s{font-size:.85em;opacity:.8}\
.nj-svc{border-left:3px solid #2878ff;padding:.5em .9em;margin:.6em 0;background:rgba(127,127,127,.05);border-radius:0 .4em .4em 0}\
.nj-svc.drop{border-color:#cc1f1a}.nj-svc.none{border-color:rgba(127,127,127,.5)}.nj-svc.mcast{border-color:#b04fd1}\
.nj-svc-h{font-weight:bold;margin-bottom:.3em}\
.nj-wan{display:inline-block;margin-left:.5em;padding:.05em .55em;border-radius:1em;background:rgba(40,120,255,.18);font-weight:normal;font-size:.85em}\
.nj-line{display:flex;align-items:center;gap:0;margin:.35em 0;flex-wrap:nowrap;overflow-x:auto}\
.nj-end{font-size:.85em;white-space:nowrap;padding:0 .4em;opacity:.85}\
.nj-wire-h{flex:1 1 1.5em;min-width:1em;height:3px;background:#1f9d9d;border-radius:2px}\
.nj-svc.drop .nj-wire-h{background:#cc1f1a}\
.nj-pill{white-space:nowrap;border:2px solid #1f9d9d;border-radius:1em;padding:.05em .7em;font-size:.85em;font-weight:bold}\
.nj-pill.rule{background:rgba(31,157,157,.18)}.nj-pill.drop{border-color:#cc1f1a;color:#cc1f1a}\
.nj-pill.xlate,.nj-pill.stack,.nj-pill.tag{border-color:#d99a00;background:rgba(217,154,0,.15)}\
.nj-graph{position:relative;overflow-x:auto;overflow-y:hidden;border:1px solid rgba(127,127,127,.3);border-radius:.5em;padding:.6em;margin:.5em 0}\
.nj-wires{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}\
.nj-wire{fill:none;stroke:rgba(127,127,127,.65);stroke-width:1.6}.nj-wire.ds{stroke-dasharray:5 4}\
.nj-wire-label{font-size:10px;fill:currentColor;opacity:.7}\
.nj-cols{display:grid;gap:1.6em;position:relative;min-width:max-content}\
.nj-col{display:flex;flex-direction:column;gap:.55em}\
.nj-col-h{font-size:.75em;font-weight:bold;text-transform:uppercase;letter-spacing:.04em;opacity:.7;margin-bottom:.2em}\
.nj-node{border:1px solid rgba(127,127,127,.45);border-left:3px solid #2878ff;border-radius:.4em;padding:.35em .55em;background:var(--background-color-high,rgba(30,30,30,.03));position:relative;font-size:.9em}\
.nj-node.ds{border-left-style:dashed}.nj-node.warn{border-left-color:#d99a00}.nj-node.veip{border-left-color:#1f9d55}\
.nj-t{font-weight:bold}.nj-chip{margin-top:.25em;font-size:.78em;border:1px solid rgba(40,120,255,.6);border-radius:.3em;padding:0 .35em;display:inline-block}\
.nj-chip.warn{border-color:#d99a00}.nj-empty{opacity:.5}\
.nj-tags{display:flex;flex-wrap:wrap;gap:.5em;margin:.4em 0}.nj-tag{border:1px solid rgba(127,127,127,.45);border-radius:1em;padding:.05em .7em;font-size:.85em}\
.nj-issue{display:flex;gap:.6em;margin:.3em 0;align-items:baseline}.nj-ico{flex:none;width:1.2em;text-align:center;color:#2878ff}\
.nj-issue.warn .nj-ico{color:#d99a00}\
.nj-drop{color:#cc1f1a;font-weight:bold}.nj-pass{color:#1f9d55;font-weight:bold}\
';

return view.extend({
	load: function() {
		return Promise.all([
			nc.callProvision(),
			L.resolveDefault(nc.callChain('ATM_VC_TBL'), null)
		]);
	},

	render: function(res) {
		var d = res[0], wans = wanNames(res[1]);
		if (!d || d.error)
			return E('div', {}, [ nc.style(), E('h2', {}, _('Provisioning')),
				E('p', { 'class': 'alert-message warning' }, (d && d.error) || _('OMCI data not available')) ]);

		var m = buildModel(d), svcs = buildServices(m, wans), issues = findIssues(m, svcs, wans);
		var truncated = Object.keys(d.me || {}).filter(function(c) { return d.me[c].truncated; });

		var section = function(title, intro, body) {
			return E('div', { 'class': 'cbi-section' }, [ E('h3', {}, title), intro ? E('p', { 'class': 'cbi-section-descr' }, intro) : '', body ]);
		};

		return E('div', {}, [
			nc.style(), E('style', {}, CSS),
			E('h2', {}, _('Provisioning')),
			E('p', { 'class': 'cbi-map-descr' }, [
				_('What your provider set up on this ONT over OMCI: the services, the path each one takes through the ONT, and how upstream traffic is queued. Read %s.').format(
					d.updated ? new Date(d.updated * 1000).toLocaleTimeString() : '-'), ' ',
				E('button', { 'class': 'cbi-button cbi-button-action', 'click': function() { location.reload(); } }, _('Read again'))
			]),
			truncated.length ? E('p', { 'class': 'alert-message warning' }, _('omcicli cut off the answer for ME %s; that part may be incomplete.').format(truncated.join(', '))) : '',
			renderIdentity(d),
			issues.length ? section(_('Worth a look'), null, E('div', { 'class': 'nj-issues' }, issues.map(function(i) {
				return E('div', { 'class': 'nj-issue ' + i[0] }, [ E('span', { 'class': 'nj-ico' }, i[0] == 'warn' ? '⚠' : 'ⓘ'), E('span', {}, i[1]) ]);
			}))) : '',
			section(_('Services'), _('Each line is one VLAN path between a port of this ONT and the OLT. The middle label says what the ONT does with it (ME 84 VLAN filters + ME 171 VLAN rules).'),
				renderServices(m, svcs)),
			section(_('VLAN rules (ME 171) in words'), _('The extended VLAN tagging rules per port, upstream direction; downstream applies them in reverse.'),
				renderRules(m)),
			section(_('The provider\'s set-up'), _('Every ME on the data path, fibre on the left, ONT ports on the right. Dashed: downstream only.'),
				renderSetup(m)),
			section(_('Speeds and priorities (QoS)'), null, renderQos(m, svcs))
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
