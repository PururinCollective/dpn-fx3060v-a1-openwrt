'use strict';
'require baseclass';
'require dom';
'require rpc';
'require uci';
'require ui';

/*
 * Shared helpers for luci-app-nijika: rpc declarations, OMCI decoders and
 * small render helpers. Backend: /usr/libexec/rpcd/nijika
 */

var ME_NAMES = {
	2: 'ONT data', 5: 'Cardholder', 6: 'Circuit pack', 7: 'Software image',
	11: 'PPTP Ethernet UNI', 45: 'MAC bridge service profile',
	47: 'MAC bridge port config data', 53: 'PPTP POTS UNI',
	84: 'VLAN tagging filter data', 130: '802.1p mapper service profile',
	131: 'OLT-G', 134: 'IP host config data', 136: 'TCP/UDP config data',
	137: 'Network address', 138: 'VoIP config data', 139: 'VoIP voice CTP',
	142: 'VoIP media profile', 143: 'RTP profile data', 150: 'SIP agent config data',
	153: 'SIP user data', 171: 'Extended VLAN tagging operation config data',
	256: 'ONT-G', 257: 'ONT2-G', 262: 'T-CONT', 263: 'ANI-G', 264: 'UNI-G',
	266: 'GEM interworking TP', 268: 'GEM port network CTP', 277: 'Priority queue',
	278: 'Traffic scheduler', 280: 'Traffic descriptor', 281: 'Multicast GEM IW TP',
	287: 'OMCI', 309: 'Multicast operations profile',
	310: 'Multicast subscriber config info', 329: 'Virtual Ethernet interface point (VEIP)',
	332: 'Enhanced security control', 340: 'BBF TR-069 management server',
	347: 'IPv6 host config data'
};

/* G.988 9.3.13, attribute 1 of ME 171 */
var ASSOC_TYPES = {
	0: 'MAC bridge port', 1: '802.1p mapper', 2: 'PPTP Eth UNI', 3: 'IP host',
	4: 'PPTP xDSL UNI', 5: 'GEM IW TP', 6: 'Mcast GEM IW TP', 7: 'PPTP MoCA UNI',
	9: 'Ethernet flow TP', 10: 'VEIP', 11: 'MPLS PW TP', 12: 'EFM bonding group'
};

/* ATM_VC_TBL (stock WAN connections). applicationtype is a service bitmask
 * (X_CT_SRV_*: TR069 1, INTERNET 2, OTHER 4, VOICE 8), ChannelMode the
 * connection type (CHANNEL_MODE_*). The stock GUI names a connection
 * Connection_<n> after its VC index (ifIndex & 0xff), which stays the same
 * when another record is deleted; NijikaWrt calls it PON_<n>. */
var WAN_SERVICES = [ [ 2, _('Internet') ], [ 8, _('VoIP') ], [ 4, _('Other/IPTV') ], [ 1, 'TR-069' ] ];
var WAN_MODES = {
	0: _('Bridged'), 1: 'IPoE', 2: 'PPPoE', 3: 'PPPoA', 4: _('1483 routed'), 5: '1577',
	6: 'DS-Lite', 8: '6rd', 9: '6in4', 10: '6to4'
};

var STATE_TEXT = {
	O1: _('Initial'), O2: _('Standby'), O3: _('Serial number'), O4: _('Ranging'),
	O5: _('Operation'), O6: _('Intermittent LODS'), O7: _('Emergency stop')
};

function hexToAscii(v) {
	var h = String(v || '').trim().replace(/^0x/i, '');
	if (!/^[0-9a-f]+$/i.test(h) || h.length < 2 || h.length % 2)
		return null;
	var s = '';
	for (var i = 0; i < h.length; i += 2) {
		var c = parseInt(h.substr(i, 2), 16);
		if (c === 0)
			continue;
		if (c < 32 || c > 126)
			return null;
		s += String.fromCharCode(c);
	}
	return s.length ? s : null;
}

function attr(inst, key) {
	var lk = String(key).toLowerCase();
	for (var i = 0; i < (inst.attrs || []).length; i++)
		if (String(inst.attrs[i][0]).toLowerCase() == lk)
			return inst.attrs[i][1];
	return null;
}

function toInt(v) {
	if (v == null)
		return NaN;
	v = String(v).trim();
	return /^0x/i.test(v) ? parseInt(v, 16) : parseInt(v, 10);
}

/* ME 84 FilterTbl entries carry a TCI (PCP|CFI|VID) or a printed VID. */
function vtfdVids(inst) {
	var vids = [];
	(inst.attrs || []).forEach(function(a) {
		if (!/^FilterTbl/i.test(a[0]))
			return;
		String(a[1]).split(/\n/).forEach(function(v) {
			var m = v.match(/vid\D{0,3}(\d+)/i);
			if (m)
				vids.push(+m[1]);
			else if (/^0x[0-9a-f]+$/i.test(v.trim()))
				vids.push(parseInt(v, 16) & 0x0fff);
			else if (/^\d+$/.test(v.trim()))
				vids.push(+v.trim());
		});
	});
	return vids;
}

/* UNI label for ME 171 AssociatedMePoint (same mapping as NIJIKA get_mib171.sh) */
function uniLabel(assocType, mePoint) {
	var mp = toInt(mePoint), t = toInt(assocType), label;
	if (isNaN(mp))
		return '-';
	if (t == 10 || ((mp & 0x0600) && !(mp & 0x0100)))
		label = 'VEIP';
	else if (mp > 65280)
		label = 'VETH' + (mp & 0xff);
	else if (mp & 0x0100)
		label = 'LAN' + (mp & 0xff);
	else if (mp & 0x4000)
		label = 'PPP';
	else
		label = 'VETH';
	return label;
}

/* ME 171 rule table: groups of Filter Outer/Inner + Treatment Outer/Inner */
function extVlanRules(inst) {
	var rules = [], cur = null;
	String(inst.raw || '').split(/\n/).forEach(function(line) {
		var m = line.match(/(Filter|Treatment)\s+(Outer|Inner)[^:]*:\s*(.*)$/i);
		if (!m)
			return;
		var kind = m[1].toLowerCase() + m[2].charAt(0).toUpperCase() + m[2].substr(1).toLowerCase(),
		    body = m[3],
		    vid = (body.match(/VID\D{0,3}(\d+)/i) || [])[1],
		    pri = (body.match(/Pri(?:ority)?\D{0,3}(\d+)/i) || [])[1],
		    tpid = (body.match(/TPID\D{0,3}(0x[0-9a-f]+|\d+)/i) || [])[1],
		    rm = (body.match(/RemoveTags\D{0,3}(\d+)/i) || [])[1];
		if (kind == 'filterOuter' || !cur) {
			cur = {};
			rules.push(cur);
		}
		cur[kind] = { vid: vid, pri: pri, tpid: tpid, rm: rm, raw: body };
	});
	return rules;
}

function fmtFilter(f) {
	if (!f) return '-';
	if (f.pri == '15') return _('no tag');
	if (f.pri == '14') return _('default');
	var vid = (f.vid == '4096') ? _('any') : f.vid;
	var pri = (f.pri == '8') ? '' : ' p' + f.pri;
	return vid + pri;
}

function fmtTreat(t) {
	if (!t) return '-';
	if (t.pri == '15') return _('no tag');
	var vid = (t.vid == '4096') ? _('copy inner') : (t.vid == '4097') ? _('copy outer') : t.vid;
	var pri = (t.pri == '8') ? ' p=inner' : (t.pri == '9') ? ' p=outer' : ' p' + t.pri;
	return vid + pri;
}

function stateBadge(state, los) {
	var cls = 'nijika-badge ' + (los ? 'bad' : (/^O5/.test(state) ? 'ok' : (/^O7/.test(state) || !state) ? 'bad' : 'warn'));
	var key = (state || '').substr(0, 2);
	return E('span', { 'class': cls }, [
		state || _('unknown'),
		' ',
		E('small', {}, los ? _('Loss of signal') : (STATE_TEXT[key] || ''))
	]);
}

/* Horizontal level bar: value within [min,max], good window [lo,hi]. */
function levelBar(value, unit, min, max, lo, hi) {
	var v = parseFloat(value);
	if (isNaN(v))
		return E('em', {}, _('n/a'));
	var pct = Math.max(0, Math.min(100, (v - min) / (max - min) * 100));
	var cls = (v >= lo && v <= hi) ? 'ok' : (v >= lo - 1 && v <= hi + 1) ? 'warn' : 'bad';
	return E('div', { 'class': 'nijika-level' }, [
		E('div', { 'class': 'nijika-level-track' },
			E('div', { 'class': 'nijika-level-bar ' + cls, 'style': 'width:%.1f%%'.format(pct) })),
		E('span', { 'class': 'nijika-level-val ' + cls }, '%s %s'.format(v.toFixed(2), unit))
	]);
}

function kvTable(rows) {
	return E('table', { 'class': 'table' }, rows.filter(function(r) { return r; }).map(function(r) {
		return E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td left', 'style': 'width:33%' }, r[0]),
			E('td', { 'class': 'td left' }, r[1])
		]);
	}));
}

var CSS = '\
.nijika-badge{display:inline-block;padding:.15em .6em;border-radius:1em;font-weight:bold;color:#fff}\
.nijika-badge small{font-weight:normal;opacity:.9}\
.nijika-badge.ok{background:#1f9d55}.nijika-badge.warn{background:#d99a00}.nijika-badge.bad{background:#cc1f1a}\
.nijika-level{display:flex;align-items:center;gap:.8em}\
.nijika-level-track{position:relative;height:.9em;width:16em;max-width:50%;background:rgba(127,127,127,.18);border-radius:1em;overflow:hidden}\
.nijika-level-bar{position:absolute;left:0;top:0;bottom:0;border-radius:1em}\
.nijika-level-bar.ok{background:linear-gradient(90deg,#00dcff,#2878ff,#af5aff)}\
.nijika-level-bar.warn{background:#e0a800}.nijika-level-bar.bad{background:#cc1f1a}\
.nijika-level-val{font-weight:bold;font-family:monospace;white-space:nowrap}\
.nijika-level-val.warn{color:#d99a00}.nijika-level-val.bad{color:#cc1f1a}\
.nijika-pre{white-space:pre-wrap;font-family:monospace;font-size:90%;max-height:40em;overflow:auto;background:rgba(127,127,127,.08);padding:.6em;border-radius:3px}\
.nijika-mono{font-family:monospace}\
.nijika-vlan sup{color:#2878ff}.nijika-vlan sub{color:#1f9d55}\
.nijika-vlan .drop{color:#cc1f1a;font-weight:bold}.nijika-vlan .pop{opacity:.75}\
.nijika-hint{opacity:.75;font-size:90%}';

return baseclass.extend({
	ME_NAMES: ME_NAMES,
	ASSOC_TYPES: ASSOC_TYPES,
	STATE_TEXT: STATE_TEXT,

	callStatus: rpc.declare({ object: 'nijika', method: 'status' }),
	callOlt: rpc.declare({ object: 'nijika', method: 'olt' }),
	callMe: rpc.declare({ object: 'nijika', method: 'me', params: [ 'class' ] }),
	callProvision: rpc.declare({ object: 'nijika', method: 'provision' }),
	callDiag: rpc.declare({ object: 'nijika', method: 'diag', params: [ 'cmd' ] }),
	callMibAll: rpc.declare({ object: 'nijika', method: 'mib_all' }),
	callMibSet: rpc.declare({ object: 'nijika', method: 'mib_set', params: [ 'values' ] }),
	callMibGet: rpc.declare({ object: 'nijika', method: 'mib_get', params: [ 'keys' ], expect: { values: {} } }),
	callVoipGet: rpc.declare({ object: 'nijika', method: 'voip_get', expect: { lines: [] } }),
	callVoipSet: rpc.declare({ object: 'nijika', method: 'voip_set', params: [ 'values' ] }),
	callWps: rpc.declare({ object: 'nijika', method: 'wps', params: [ 'radio', 'action', 'pin' ] }),
	callEasymeshGet: rpc.declare({ object: 'nijika', method: 'easymesh_get' }),
	callEasymeshSet: rpc.declare({ object: 'nijika', method: 'easymesh_set', params: [ 'role', 'backhaul', 'name' ] }),
	callEasymeshPair: rpc.declare({ object: 'nijika', method: 'easymesh_pair' }),
	callPortfwGet: rpc.declare({ object: 'nijika', method: 'portfw_get' }),
	callPortfwSet: rpc.declare({ object: 'nijika', method: 'portfw_set', params: [ 'enable', 'rules' ] }),
	callWanStatus: rpc.declare({ object: 'nijika', method: 'wan_status', expect: { wans: [] } }),
	callDdnsStatus: rpc.declare({ object: 'nijika', method: 'ddns_status' }),
	callDdnsUpdate: rpc.declare({ object: 'nijika', method: 'ddns_update' }),
	callWgStatus: rpc.declare({ object: 'nijika', method: 'wg_status' }),
	callWgKeys: rpc.declare({ object: 'nijika', method: 'wg_keys', params: [ 'private_key' ] }),
	callWgClient: rpc.declare({ object: 'nijika', method: 'wg_client', params: [ 'section' ] }),
	callChain: rpc.declare({ object: 'nijika', method: 'chain', params: [ 'table' ] }),
	callQuickGet: rpc.declare({ object: 'nijika', method: 'quick_get' }),
	callQuickSet: rpc.declare({ object: 'nijika', method: 'quick_set', params: [ 'pon', 'wan', 'wifi', 'voip' ] }),
	callIdentGet: rpc.declare({ object: 'nijika', method: 'ident_get' }),
	callIdentSet: rpc.declare({ object: 'nijika', method: 'ident_set', params: [ 'preset' ] }),
	callBootGet: rpc.declare({ object: 'nijika', method: 'boot_get' }),
	callBootSet: rpc.declare({ object: 'nijika', method: 'boot_set', params: [ 'bank', 'mode' ] }),
	callFwCheck: rpc.declare({ object: 'nijika', method: 'fw_check' }),
	callFwFlash: rpc.declare({ object: 'nijika', method: 'fw_flash', params: [ 'mode', 'replace_stock' ] }),
	callFwStatus: rpc.declare({ object: 'nijika', method: 'fw_status' }),
	callReboot: rpc.declare({ object: 'nijika', method: 'reboot' }),

	hexToAscii: hexToAscii,
	attr: attr,
	toInt: toInt,
	vtfdVids: vtfdVids,
	uniLabel: uniLabel,
	extVlanRules: extVlanRules,
	fmtFilter: fmtFilter,
	fmtTreat: fmtTreat,
	stateBadge: stateBadge,
	levelBar: levelBar,
	kvTable: kvTable,

	style: function() {
		return E('style', {}, CSS);
	},

	/* wan_status for the Overview cards of one poll (PON and WAN share it) */
	wanStatus: function() {
		var now = Date.now();
		if (!this._wanAt || now - this._wanAt > 2500) {
			this._wanAt = now;
			this._wan = L.resolveDefault(this.callWanStatus(), []);
		}
		return this._wan;
	},

	meName: function(cls, fallback) {
		return ME_NAMES[cls] || fallback || _('Managed entity');
	},

	/* "0x48575443 (HWTC)" */
	hexLabel: function(v) {
		var a = hexToAscii(v);
		return a ? '%s (%s)'.format(v, a) : (v == null ? '-' : v);
	},

	/* ATM_VC_TBL.vprio is the index of the stock GUI's priority list:
	 * 0 = "-" (no 802.1p marking), n = priority n - 1 (stock SDKs, also the
	 * old PON stick GUI) */
	vprioValues: function(o) {
		o.value('0', '-');
		for (var p = 0; p <= 7; p++)
			o.value(String(p + 1), String(p));
	},

	vprioText: function(raw) {
		var n = parseInt(raw, 10);
		return (isNaN(n) || n <= 0) ? '-' : String(n - 1);
	},

	wanServices: WAN_SERVICES,
	wanModes: WAN_MODES,

	/* "Internet + VoIP" */
	wanService: function(rec) {
		var t = +rec.applicationtype || 0;
		return WAN_SERVICES.filter(function(s) { return t & s[0]; })
			.map(function(s) { return s[1]; }).join(' + ') || _('no service');
	},

	/* the stock list's names: IPoE with a DHCP address is "DHCP" */
	wanMode: function(rec) {
		if (rec.ChannelMode == '1' && rec.ChannelAddrType == '1')
			return 'DHCP';
		return WAN_MODES[rec.ChannelMode] || _('mode %s').format(rec.ChannelMode);
	},

	/* "PON_0" (VC index; record index when ifIndex is unknown) */
	wanName: function(rec, idx) {
		var i = parseInt(rec.ifIndex, 10);
		return 'PON_%d'.format(isNaN(i) ? idx : (i & 0xff));
	},

	/* "PON_0: Internet (PPPoE)" */
	wanLabel: function(rec, idx) {
		return '%s: %s (%s)'.format(this.wanName(rec, idx), this.wanService(rec), this.wanMode(rec));
	},

	/* Reply of mib_set / quick_set -> notification text. applied: areas the
	 * running stack was told about (as the stock GUI's Apply does),
	 * reboot_required: something else is only read at boot. */
	applyText: function(res, what) {
		var names = {
			firewall: _('firewall'), lan: _('LAN'), wlan: _('WiFi'), loid: _('PON registration'),
			ploam: _('PON registration'), omci: _('PON registration'), voip: _('VoIP'),
			snooping: _('IGMP snooping'), wlanblock: _('LAN/WiFi blocking'), portfw: _('port forwarding')
		};
		var seen = {}, list = [];
		(res && res.applied || []).forEach(function(a) {
			var n = /^wan:\d+$/.test(a) ? _('WAN') :
				/^port:\d+$/.test(a) ? _('LAN port %d').format(+a.substr(5) + 1) : (names[a] || a);
			if (!seen[n]) { seen[n] = true; list.push(n); }
		});
		var msg = what || _('Saved to the stock configuration.');
		if (list.length)
			msg += ' ' + _('Applying to the running stack: %s.').format(list.join(', '));
		if (res && res.reboot_required)
			msg += ' ' + _('Some of it takes effect after a reboot.');
		return msg;
	},

	/* Save a form.JSONMap section of MIB keys like the stock GUI's Apply:
	 * only changed keys, through mib_set (flash set + live apply). orig holds
	 * the loaded values and is updated. Only keys of fields that are shown
	 * count: LuCI drops the value of a field its dependencies hide, which
	 * must not read as "cleared". A field writing another key names it in
	 * option.key. */
	mibSave: function(map, sid, orig, keys, what) {
		var self = this, shown = {};
		map.children.forEach(function(s) {
			if (s.section != sid)
				return;
			s.children.forEach(function(o) {
				if (o.isActive(sid))
					shown[o.key || o.option] = true;
			});
		});
		return map.save().then(function() {
			var values = [];
			keys.filter(function(k) { return shown[k]; }).forEach(function(k) {
				var v = map.data.get('json', sid, k);
				v = (v == null) ? '' : String(v);
				if (v !== (orig[k] == null ? '' : String(orig[k])))
					values.push([ k, v ]);
			});
			if (!values.length) {
				ui.addNotification(null, E('p', _('Nothing changed.')), 'info');
				return null;
			}
			return self.callMibSet(values).then(function(r) {
				if (!r || r.error || (r.failed && r.failed.length))
					throw new Error((r && r.error) || _('rejected: %s').format((r.failed || []).join(', ')));
				values.forEach(function(kv) { orig[kv[0]] = kv[1]; });
				ui.addNotification(null, E('p', self.applyText(r, what)), 'info');
				return r;
			});
		}).catch(function(e) {
			ui.addNotification(null, E('p', _('Saving failed: %s').format(e.message || e)), 'danger');
		});
	},

	/* Load and render a view again in place, e.g. after a save, so the
	 * page shows what the stock configuration holds now. Notifications are
	 * outside the view and stay. */
	reloadView: function(view) {
		return Promise.resolve(view.load()).then(L.bind(view.render, view)).then(function(nodes) {
			var vp = document.getElementById('view');
			dom.content(vp, nodes);
			dom.append(vp, view.addFooter());
		});
	},

	/* uci-backed pages of the stock configuration (/etc/config/rtk): once
	 * Save & Apply is confirmed, read the configuration again and redraw,
	 * so the page shows what the stock stack now holds (the mirror writes
	 * it to flash and rebuilds the file from there). */
	reloadAfterApply: function(view, config) {
		var self = this;
		document.addEventListener('uci-applied', function() {
			window.setTimeout(function() {
				uci.unload(config || 'rtk');
				self.reloadView(view);
			}, 1500);
		}, { once: true });
	},

	/* Keep a status box under a form.Map's title and description: LuCI
	 * redraws the map's contents after a modal save or a reset, which
	 * drops nodes added to it, so put it back after every redraw. */
	mapStatusBox: function(m, box) {
		var renderContents = m.renderContents;
		m.renderContents = function() {
			return renderContents.apply(this, arguments).then(function(node) {
				var descr = node.querySelector('.cbi-map-descr');
				node.insertBefore(box, descr ? descr.nextSibling : node.firstChild);
				return node;
			});
		};
		return box;
	},

	rebootPrompt: function(self, msg) {
		ui.showModal(_('Reboot required'), [
			E('p', {}, msg || _('The stock configuration was saved. The PON/WAN stack picks it up after a reboot.')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Later')),
				' ',
				E('button', {
					'class': 'btn cbi-button-action important',
					'click': function() {
						self.callReboot().then(function() {
							ui.showModal(_('Rebooting…'), [ E('p', { 'class': 'spinning' }, _('The device is rebooting, this page reloads when it is back.')) ]);
							ui.awaitReconnect();
						});
					}
				}, _('Reboot now'))
			])
		]);
	}
});
