'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require nijika.common as nc';

/*
 * Network > QoS: the stock GUI's Advance > Upstream QoS Policy, Downstream
 * QoS Policy, QoS Classification and Traffic Shaping pages, one tab each,
 * with the stock wording. The stock IP QoS does the work: queues, rules and
 * rate limits in the switch / PON hardware, so traffic keeps its hardware
 * acceleration. rpcd qos_get / qos_set (/usr/lib/nijika/qos.sh) read and
 * write the records the stock forms write; saving applies them like the
 * stock forms (stopIPQ, take_qos_effect).
 *
 * Encodings (as the stock pages): DSCP codes (DSCP << 2) | 1, 802.1p + 1
 * (0 none), Protocol bits TCP 1, UDP 2, ICMP 4, RTP 8, connection types
 * as applicationtype bits (TR069 1, INTERNET 2, IPTV 4, VOICE 8).
 */

var ANY_WAN = '65535';

var DSCPS = [ [ 1, 'Default(000000)' ], [ 57, 'AF13(001110)' ], [ 49, 'AF12(001100)' ], [ 41, 'AF11(001010)' ],
	[ 33, 'CS1(001000)' ], [ 89, 'AF23(010110)' ], [ 81, 'AF22(010100)' ], [ 73, 'AF21(010010)' ], [ 65, 'CS2(010000)' ],
	[ 121, 'AF33(011110)' ], [ 113, 'AF32(011100)' ], [ 105, 'AF31(011010)' ], [ 97, 'CS3(011000)' ],
	[ 153, 'AF43(100110)' ], [ 145, 'AF42(100100)' ], [ 137, 'AF41(100010)' ], [ 129, 'CS4(100000)' ],
	[ 185, 'EF(101110)' ], [ 161, 'CS5(101000)' ], [ 193, 'CS6(110000)' ], [ 225, 'CS7(111000)' ] ];

var CONNTYPES = [ [ 3, 'TR069_INTERNET' ], [ 2, 'INTERNET' ], [ 1, 'TR069' ], [ 4, 'IPTV' ], [ 8, 'VOICE' ],
	[ 9, 'TR069_VOICE' ], [ 10, 'VOICE_INTERNET' ], [ 11, 'TR069_VOICE_INTERNET' ] ];

var PROTO_BITS = { tcp: 1, udp: 2, icmp: 4, rtp: 8 };

function ports(a, b) {
	if (!+a)
		return '';
	return (+b && +b != +a) ? '%d-%d'.format(+a, +b) : String(+a);
}

function range(v) {
	var m = String(v || '').trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
	return m ? [ +m[1], m[2] ? +m[2] : 0 ] : null;
}

function validPorts(sid, v) {
	if (v == null || v === '')
		return true;
	var r = range(v);
	return (r && r[0] >= 1 && r[0] <= 65535 && r[1] <= 65535 && (!r[1] || r[1] >= r[0])) ? true : _('Invalid port');
}

/* prefix length <-> dotted mask */
function bitsToMask(b) {
	b = +b || 0;
	if (!b)
		return '';
	var o = [];
	for (var i = 0; i < 4; i++)
		o.push(256 - Math.pow(2, 8 - Math.min(8, Math.max(0, b - 8 * i))));
	return o.join('.');
}

function maskToBits(v) {
	v = String(v || '').trim();
	if (v === '')
		return 0;
	if (/^\d+$/.test(v))
		return +v <= 32 ? +v : null;
	var m = v.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/), n, bits;
	if (!m)
		return null;
	n = ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0;
	for (bits = 0; bits < 32 && (n & (0x80000000 >>> bits)); bits++);
	/* the rest must be zero (a shift by 32 is a shift by 0 in JavaScript) */
	return (bits == 32 || ((n << bits) >>> 0) == 0) ? bits : null;
}

function validMask(sid, v) {
	return maskToBits(v) != null ? true : _('Invalid mask');
}

function mac(v) {
	v = String(v || '').toLowerCase();
	return (/^[0-9a-f]{12}$/.test(v) && !/^0+$/.test(v)) ? v.match(/../g).join(':') : '';
}

function ip(v, none) {
	return (v && v != none) ? v : '';
}

/* list cell of a ListValue: its label, not the stored value */
function choiceText(sid) {
	var v = this.cfgvalue(sid), i;
	v = String(v != null ? v : (this.default != null ? this.default : ''));
	i = this.keylist.indexOf(v);
	return i >= 0 ? this.vallist[i] : v;
}

function dscpList(o) {
	o.value('0', '-');
	DSCPS.forEach(function(d) { o.value(String(d[0]), d[1]); });
	o.default = '0';
	o.textvalue = choiceText;
}

function dot1pList(o) {
	o.value('0', '-');
	for (var i = 0; i <= 7; i++)
		o.value(String(i + 1), String(i));
	o.default = '0';
	o.textvalue = choiceText;
}

function wanList(o, family, none) {
	o.value(ANY_WAN, none);
	uci.sections('rtk', 'ATM_VC_TBL').forEach(function(r, i) {
		if (r.ChannelMode != '0' && (!family || (+r.IpProtocol & family)))
			o.value(String(r.ifIndex), nc.wanLabel(r, i));
	});
	o.default = ANY_WAN;
	o.textvalue = choiceText;
}

function flag(v) {
	return v == '1' || v === true ? 1 : 0;
}

/* Upstream / Downstream QoS Policy: the stock page's switches and its queue
 * table (Queue, Priority; the caller adds the policy's columns). With QoS
 * off the stock page hides the rest but still submits it: hidden values
 * are kept (retain). */
function policySection(m, dir, title, descr, limitTitle, policies, qtype) {
	var s = m.section(form.NamedSection, dir, dir, title, descr), o, ss, sp = {};
	o = s.option(form.Flag, 'enable', _('Enable QoS'));
	o.rmempty = false;
	o = s.option(form.Flag, 'limit', limitTitle);
	o.rmempty = false;
	o.depends('enable', '1');
	o.retain = true;
	o = s.option(form.Flag, 'dscp', _('DSCP/TC Remark'));
	o.rmempty = false;
	o.depends('enable', '1');
	o.retain = true;
	o = s.option(form.ListValue, 'remark_1p', _('802.1p Remark'));
	o.value('0', _('Disable'));
	o.value('1', _('Transparent'));
	o.value('2', _('Translate'));
	o.depends('enable', '1');
	o.retain = true;
	o = s.option(form.ListValue, 'policy', _('QoS Policy Select'));
	policies.forEach(function(p, i) { o.value(String(i), p); });
	o.depends('enable', '1');
	o.retain = true;
	o = s.option(form.SectionValue, '_queues', form.TableSection, qtype);
	o.depends('enable', '1');
	ss = o.subsection;
	ss.anonymous = true;
	ss.addremove = false;
	ss.sortable = false;
	ss.nodescriptions = true;
	ss.option(form.DummyValue, 'qname', _('Queue'));
	o = ss.option(form.DummyValue, 'prio', _('Priority'));
	sp['json.' + dir + '.policy'] = '0';
	o.depends(sp);
	return ss;
}

/* A rule grid with its edit dialog: a new row gets a name of its own
 * (JSONMap numbers rows by count), and the rest of the form is parsed into
 * the data before the dialog opens: saving or dismissing the dialog reloads
 * the whole map from the data, which would drop changes not saved yet
 * (Enable QoS on another tab, say). */
function ruleGrid(s) {
	s.handleAdd = function(ev) {
		return form.GridSection.prototype.handleAdd.call(this, ev, 'new%d'.format(Date.now()));
	};
	s.renderMoreOptionsModal = function() {
		var self = this, args = arguments;
		return Promise.resolve(this.map.parse()).catch(function() {}).then(function() {
			return form.GridSection.prototype.renderMoreOptionsModal.apply(self, args);
		});
	};
	nc.modalSaveErrors(s);
}

/* classification row -> qos_set rule (the fields of qos_rule_fields) */
function rulePayload(r) {
	var sp = range(r.sport) || [ 0, 0 ], dp = range(r.dport) || [ 0, 0 ], flow = r.classtype != '1';
	var out = {
		name: r.name || '', direction: +r.direction || 0, ipver: +r.ipver || 1, classtype: flow ? 0 : 1,
		conntype: flow ? 0 : (+r.conntype || 0), outif: +r.outif || 65535,
		prio: +r.prio || 1, mdscp: +r.mdscp || 0, m1p: +r.m1p || 0
	};
	if (!flow)
		return out;
	Object.assign(out, {
		phyport: +r.phyport || 0, dscp: +r.dscp || 0, vlan1p: +r.vlan1p || 0,
		proto: L.toArray(r.proto).reduce(function(t, k) { return t | (PROTO_BITS[k] || 0); }, 0),
		sport: sp[0], sport_end: sp[1], dport: dp[0], dport_end: dp[1], smac: r.smac || '', dmac: r.dmac || ''
	});
	if (out.ipver == 1)
		Object.assign(out, { sip: r.sip || '', smask: maskToBits(r.smask) || 0, dip: r.dip || '', dmask: maskToBits(r.dmask) || 0 });
	else
		Object.assign(out, { sip6: r.sip6 || '', sip6len: +r.sip6len || 0, dip6: r.dip6 || '', dip6len: +r.dip6len || 0 });
	return out;
}

/* the stock page's checks before it submits a rule */
function ruleError(r) {
	if (r.classtype)
		return r.conntype ? null : _('Please select a connection type!');
	if (!r.phyport && !r.proto && !r.dscp && !r.vlan1p && !r.sport && !r.dport && !r.smac && !r.dmac &&
	    !r.sip && !r.dip && !r.sip6 && !r.dip6 && r.outif == 65535)
		return _('Please set rule match information!');
	if ((r.sport || r.dport) && !(r.proto & 3))
		return _('Please don\'t set Port when protocol is not TCP/UDP!');
	return null;
}

/* traffic control row -> qos_set tc rule (the fields of qos_tc_fields) */
function tcPayload(r) {
	var out = { ipver: +r.ipver || 1, direction: +r.direction || 0, proto: +r.proto || 0,
		ifindex: +r.ifindex || 65535, sport: +r.sport || 0, dport: +r.dport || 0, rate: +r.rate || 0 };
	if (out.ipver != 2)
		Object.assign(out, { sip: r.sip || '', smask: maskToBits(r.smask) || 0, dip: r.dip || '', dmask: maskToBits(r.dmask) || 0 });
	if (out.ipver != 1)
		Object.assign(out, { sip6: r.sip6 || '', sip6len: +r.sip6len || 0, dip6: r.dip6 || '', dip6len: +r.dip6len || 0 });
	return out;
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(nc.callQosGet(), {}),
			uci.load('rtk')
		]);
	},

	render: function(data) {
		var q = data[0] || {}, mib = q.mib || {}, m, s, ss, o;
		var recs = function(c) { return (c && c.records) || []; };

		this.rulesMax = +q.rules_max || 0;
		this.tcMax = +q.tc_max || 0;

		var json = {
			up: { enable: mib.ENABLE_QOS || '0', limit: mib.TOTAL_BANDWIDTH_LIMIT || '0', dscp: mib.ENABLE_DSCP_MARK || '0',
				remark_1p: mib.ENABLE_1P || '0', policy: mib.QOS_POLICY || '0' },
			down: { enable: mib.ENABLE_DOWNSTREAM_QOS || '0', limit: mib.TOTAL_DOWNSTREAM_BANDWIDTH_LIMIT || '0',
				dscp: mib.ENABLE_DOWNSTREAM_DSCP_MARK || '0', remark_1p: mib.ENABLE_DOWNSTREAM_1P || '0',
				policy: mib.QOS_DOWNSTREAM_POLICY || '0' },
			shaping: { up_bw: mib.TOTAL_BANDWIDTH_LIMIT == '1' ? (mib.TOTAL_BANDWIDTH || '') : '',
				down_bw: mib.TOTAL_DOWNSTREAM_BANDWIDTH_LIMIT == '1' ? (mib.TOTAL_DOWNSTREAM_BANDWIDTH || '') : '' },
			queue: recs(q.queues).slice(0, 8).map(function(r, i) {
				return { qname: 'Q%d'.format(i + 1), prio: String(i + 1), enable: r.enable == '0' ? '0' : '1',
					weight: r.weight || '0', car: r.car || '0' };
			}),
			dqueue: recs(q.dqueues).slice(0, 8).map(function(r, i) {
				return { qname: 'Q%d'.format(i + 1), prio: String(i + 1), enable: r.enable == '0' ? '0' : '1',
					weight: r.weight || '0', wifi: r.wifiPrior || '0' };
			}),
			rule: recs(q.rules).map(function(r) {
				var p = +r.Protocol || 0;
				return {
					name: r.Name || '', direction: r.direction == '1' ? '1' : '0', ipver: r.IPVersion == '2' ? '2' : '1',
					classtype: r.classtype == '1' ? '1' : '0', conntype: r.applicationtype || '0',
					phyport: r.PhyPort || '0', proto: Object.keys(PROTO_BITS).filter(function(k) { return p & PROTO_BITS[k]; }),
					dscp: r.qosDscp || '0', vlan1p: r.vlan1p || '0', outif: r.OutInf || ANY_WAN,
					sip: ip(r.SrcIP, '0.0.0.0'), smask: bitsToMask(r.SrcMask), dip: ip(r.DstIP, '0.0.0.0'), dmask: bitsToMask(r.DstMask),
					sip6: ip(r.SrcIP6, '::'), sip6len: +r.SrcIP6PrefixLen ? r.SrcIP6PrefixLen : '',
					dip6: ip(r.DstIP6, '::'), dip6len: +r.DstIP6PrefixLen ? r.DstIP6PrefixLen : '',
					sport: ports(r.SrcPort, r.SrcPortRangeMax), dport: ports(r.DstPort, r.DstPortRangeMax),
					smac: mac(r.SMac), dmac: mac(r.DMac), prio: r.Prior || '1', mdscp: r.m_dscp || '0', m1p: r.m_1p || '0'
				};
			}),
			tcrule: recs(q.tc).map(function(r) {
				return {
					ipver: [ '1', '2', '3' ].indexOf(r.IPVersion) >= 0 ? r.IPVersion : '1', direction: r.direction == '1' ? '1' : '0',
					proto: r.protocol || '0', ifindex: r.ifIndex || ANY_WAN,
					sip: ip(r.Srcip, '0.0.0.0'), smask: bitsToMask(r.srcmask), dip: ip(r.dstip, '0.0.0.0'), dmask: bitsToMask(r.dstmask),
					sip6: ip(r.SrcIP6, '::'), sip6len: +r.SrcIP6PrefixLen ? r.SrcIP6PrefixLen : '',
					dip6: ip(r.DstIP6, '::'), dip6len: +r.DstIP6PrefixLen ? r.DstIP6PrefixLen : '',
					sport: +r.srcport ? r.srcport : '', dport: +r.dstport ? r.dstport : '', rate: r.rate || ''
				};
			})
		};
		/* what qos_set would get for the tables as loaded: a save sends a
		 * table only when it differs */
		this.loaded = { mib: mib, rules: JSON.stringify(json.rule.map(rulePayload)), tc: JSON.stringify(json.tcrule.map(tcPayload)) };

		m = new form.JSONMap(json, _('QoS'));
		m.tabbed = true;
		this.map = m;

		/* Upstream QoS Policy (formUpstreamQosPolicy) */
		ss = policySection(m, 'up', _('Upstream QoS'), _('This page is used to configure the Upstream QoS Policy.'),
			_('Total Upstream Bandwidth Limit'), [ _('Strict Priority'), _('WRR'), _('CAR') ], 'queue');
		o = ss.option(form.Value, 'weight', _('WRR'));
		o.datatype = 'range(0,100)';
		o.depends({ 'json.up.policy': '1' });
		o.retain = true;
		o = ss.option(form.Value, 'car', _('CAR'));
		o.datatype = 'uinteger';
		o.depends({ 'json.up.policy': '2' });
		o.retain = true;
		o = ss.option(form.Flag, 'enable', _('Enable'));
		o.rmempty = false;

		/* Downstream QoS Policy (formDownstreamQosPolicy) */
		ss = policySection(m, 'down', _('Downstream QoS'), _('This page is used to configure the Downstream QoS Policy.'),
			_('Total Downstream Bandwidth Limit'), [ _('Strict Priority'), _('WRR') ], 'dqueue');
		o = ss.option(form.ListValue, 'wifi', _('Wlan Priority'));
		o.value('0', _('Background'));
		o.value('1', _('Best effort'));
		o.value('2', _('Video'));
		o.value('3', _('Voice'));
		o.depends({ 'json.down.policy': '0' });
		o.retain = true;
		o = ss.option(form.Value, 'weight', _('WRR'));
		o.datatype = 'range(0,100)';
		o.depends({ 'json.down.policy': '1' });
		o.retain = true;
		o = ss.option(form.Flag, 'enable', _('Enable'));
		o.rmempty = false;

		/* QoS Classification (formQosRule, formQosRuleEdit) */
		s = m.section(form.GridSection, 'rule', _('QoS Classification'),
			_('This page is used to configure the QoS Classify Configuration.'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = false;
		s.nodescriptions = true;
		s.addbtntitle = _('Add');
		s.modaltitle = _('Traffic Classify Rule');
		ruleGrid(s);
		s.tab('info', _('Rule Match Information'));
		s.tab('match', _('Specify Traffic Classification Rules'));
		s.tab('mark', _('Assign IP Precedence/DSCP/802.1p'));
		var self = this;
		s.renderSectionAdd = function() {
			var node = form.GridSection.prototype.renderSectionAdd.apply(this, arguments);
			if (self.rulesMax && m.data.sections('json', 'rule').length >= self.rulesMax)
				node.querySelectorAll('button, input').forEach(function(b) { b.disabled = true; });
			return node;
		};

		o = s.taboption('info', form.Value, 'name', _('Rule Name'));
		o.rmempty = false;
		o.validate = function(sid, v) { return /^[A-Za-z0-9_]{1,63}$/.test(v || '') ? true : _('Rule name is invalid!'); };
		o = s.taboption('info', form.ListValue, 'direction', _('Direction'));
		o.value('0', _('Upstream'));
		o.value('1', _('Downstream'));
		o.textvalue = choiceText;
		o = s.taboption('info', form.ListValue, 'ipver', _('IP Version'));
		o.value('1', 'IPv4');
		o.value('2', 'IPv6');
		o.textvalue = choiceText;
		o = s.taboption('info', form.ListValue, 'classtype', _('Classify Rule Type'));
		o.value('0', _('Flow Based'));
		o.value('1', _('Connection Type Based'));
		o.modalonly = true;
		o = s.taboption('info', form.DummyValue, '_wan', _('WAN Interface'));
		o.modalonly = false;
		o.textvalue = function(sid) {
			var v = m.data.get('json', sid, 'outif'), n = this.section.children.filter(function(c) {
				return c.option == (m.data.get('json', sid, 'ipver') == '2' ? 'outif6' : 'outif');
			})[0];
			return n ? choiceText.call(n, sid) : v;
		};

		o = s.taboption('match', form.ListValue, 'conntype', _('Connection Type'));
		o.value('0', _('none'));
		CONNTYPES.forEach(function(c) { o.value(String(c[0]), c[1]); });
		o.default = '0';
		o.depends('classtype', '1');
		o.textvalue = choiceText;
		o = s.taboption('match', form.ListValue, 'phyport', _('Phy Port No'));
		o.value('0', '-');
		for (var p = 1; p <= 4; p++)
			o.value(String(p), 'LAN%d'.format(p));
		o.depends('classtype', '0');
		o.modalonly = true;
		o = s.taboption('match', form.MultiValue, 'proto', _('Protocol'));
		o.value('tcp', 'TCP');
		o.value('udp', 'UDP');
		o.value('icmp', 'ICMP');
		o.value('rtp', 'RTP');
		o.depends('classtype', '0');
		o.modalonly = true;
		o = s.taboption('match', form.ListValue, 'dscp', _('DSCP'));
		dscpList(o);
		o.depends('classtype', '0');
		o.modalonly = true;
		o = s.taboption('match', form.ListValue, 'vlan1p', _('802.1p'));
		dot1pList(o);
		o.depends('classtype', '0');
		o.modalonly = true;
		o = s.taboption('match', form.ListValue, 'outif', _('IPv4 WAN Interface'));
		wanList(o, 1, _('any'));
		o.depends('ipver', '1');
		o.modalonly = true;
		o = s.taboption('match', form.Value, 'sip', _('Src IPv4 Address'));
		o.datatype = 'ip4addr("nomask")';
		o.depends({ ipver: '1', classtype: '0' });
		o.modalonly = true;
		o = s.taboption('match', form.Value, 'smask', _('Src IPv4 Mask'));
		o.validate = validMask;
		o.depends({ ipver: '1', classtype: '0' });
		o.modalonly = true;
		o = s.taboption('match', form.Value, 'dip', _('Dst IPv4 Address'));
		o.datatype = 'ip4addr("nomask")';
		o.depends({ ipver: '1', classtype: '0' });
		o.modalonly = true;
		o = s.taboption('match', form.Value, 'dmask', _('Dst IPv4 Mask'));
		o.validate = validMask;
		o.depends({ ipver: '1', classtype: '0' });
		o.modalonly = true;
		o = s.taboption('match', form.ListValue, 'outif6', _('IPv6 WAN Interface'));
		wanList(o, 2, _('any'));
		o.cfgvalue = function(sid) { return m.data.get('json', sid, 'outif') || ANY_WAN; };
		o.write = function(sid, v) { if (m.data.get('json', sid, 'ipver') == '2') m.data.set('json', sid, 'outif', v); };
		o.remove = function() {};
		o.depends('ipver', '2');
		o.modalonly = true;
		o = s.taboption('match', form.Value, 'sip6', _('Src IPv6 Address'));
		o.datatype = 'ip6addr("nomask")';
		o.depends({ ipver: '2', classtype: '0' });
		o.modalonly = true;
		o = s.taboption('match', form.Value, 'sip6len', _('Src IPv6 Prefix Length'));
		o.datatype = 'range(1,128)';
		o.depends({ ipver: '2', classtype: '0' });
		o.modalonly = true;
		o = s.taboption('match', form.Value, 'dip6', _('Dst IPv6 Address'));
		o.datatype = 'ip6addr("nomask")';
		o.depends({ ipver: '2', classtype: '0' });
		o.modalonly = true;
		o = s.taboption('match', form.Value, 'dip6len', _('Dst IPv6 Prefix Length'));
		o.datatype = 'range(1,128)';
		o.depends({ ipver: '2', classtype: '0' });
		o.modalonly = true;
		o = s.taboption('match', form.Value, 'sport', _('Src Port'));
		o.placeholder = '1-65535';
		o.validate = validPorts;
		o.depends('classtype', '0');
		o.modalonly = true;
		o = s.taboption('match', form.Value, 'dport', _('Dst Port'));
		o.placeholder = '1-65535';
		o.validate = validPorts;
		o.depends('classtype', '0');
		o.modalonly = true;
		o = s.taboption('match', form.Value, 'smac', _('Src MAC Address'));
		o.datatype = 'macaddr';
		o.depends('classtype', '0');
		o.modalonly = true;
		o = s.taboption('match', form.Value, 'dmac', _('Dst MAC Address'));
		o.datatype = 'macaddr';
		o.depends('classtype', '0');
		o.modalonly = true;

		o = s.taboption('mark', form.ListValue, 'prio', _('Precedence'));
		for (var n = 1; n <= 8; n++)
			o.value(String(n), _('Queue %d').format(n));
		o.textvalue = choiceText;
		o = s.taboption('mark', form.ListValue, 'mdscp', _('DSCP Remark'));
		dscpList(o);
		o = s.taboption('mark', form.ListValue, 'm1p', _('802.1p Remark'));
		dot1pList(o);

		/* Traffic Shaping (formQosTraffictl, formQosTraffictlEdit) */
		s = m.section(form.NamedSection, 'shaping', 'shaping', _('Traffic Shaping'),
			_('This page is used to configure the QoS Traffic Control Setting.'));
		o = s.option(form.Value, 'up_bw', _('Upstream Total Bandwidth'), _('Kb'));
		o.datatype = 'range(1,10000000)';
		o = s.option(form.Value, 'down_bw', _('Downstream Total Bandwidth'), _('Kb'));
		o.datatype = 'range(1,10000000)';
		o = s.option(form.SectionValue, '_tc', form.GridSection, 'tcrule', _('QoS Traffic Control Rules'));
		ss = o.subsection;
		ss.anonymous = true;
		ss.addremove = true;
		ss.sortable = false;
		ss.nodescriptions = true;
		ss.addbtntitle = _('Add Rule');
		ss.modaltitle = _('Add QoS Traffic Control Rule');
		ruleGrid(ss);
		ss.renderSectionAdd = function() {
			var node = form.GridSection.prototype.renderSectionAdd.apply(this, arguments);
			if (self.tcMax && m.data.sections('json', 'tcrule').length >= self.tcMax)
				node.querySelectorAll('button, input').forEach(function(b) { b.disabled = true; });
			return node;
		};
		o = ss.option(form.DummyValue, '_id', _('ID'));
		o.modalonly = false;
		o.textvalue = function(sid) {
			return String(m.data.sections('json', 'tcrule').map(function(r) { return r['.name']; }).indexOf(sid) + 1);
		};
		o = ss.option(form.ListValue, 'ipver', _('IP Version'));
		o.value('1', 'IPv4');
		o.value('2', 'IPv6');
		o.value('3', 'IPv4/IPv6');
		o.textvalue = choiceText;
		o = ss.option(form.ListValue, 'direction', _('Direction'));
		o.value('0', _('Upstream'));
		o.value('1', _('Downstream'));
		o.textvalue = choiceText;
		o = ss.option(form.ListValue, 'ifindex', _('WAN'));
		wanList(o, 0, _('n/a'));
		o = ss.option(form.ListValue, 'proto', _('Protocol'));
		o.value('0', _('NONE'));
		o.value('1', 'TCP');
		o.value('2', 'UDP');
		o.value('3', 'ICMP');
		o.textvalue = choiceText;
		o = ss.option(form.Value, 'sport', _('Source Port'));
		o.datatype = 'port';
		o.modalonly = true;
		o = ss.option(form.Value, 'dport', _('Dest Port'));
		o.datatype = 'port';
		o.modalonly = true;
		/* the list's address columns: IPv4 and IPv6 in one */
		[ [ '_sport', _('SPort'), [ 'sport' ] ], [ '_dport', _('DPort'), [ 'dport' ] ],
		  [ '_src', _('Src IP'), [ 'sip', 'sip6' ] ], [ '_dst', _('Dst IP'), [ 'dip', 'dip6' ] ] ].forEach(function(c) {
			o = ss.option(form.DummyValue, c[0], c[1]);
			o.modalonly = false;
			o.textvalue = function(sid) {
				return c[2].map(function(k) { return m.data.get('json', sid, k); }).filter(function(v) { return v; }).join(', ');
			};
		});
		[ [ 'sip', 'smask', _('Source IPv4 Address'), _('Source IPv4 Mask'), 'ip4addr("nomask")', validMask, [ '1', '3' ] ],
		  [ 'dip', 'dmask', _('Dest IPv4 Address'), _('Dest IPv4 Mask'), 'ip4addr("nomask")', validMask, [ '1', '3' ] ],
		  [ 'sip6', 'sip6len', _('Source IPv6 Address'), _('Source IPv6 Prefix length'), 'ip6addr("nomask")', null, [ '2', '3' ] ],
		  [ 'dip6', 'dip6len', _('Dest IPv6 Address'), _('Dest IPv6 Prefix length'), 'ip6addr("nomask")', null, [ '2', '3' ] ] ].forEach(function(a) {
			o = ss.option(form.Value, a[0], a[2]);
			o.datatype = a[4];
			o.modalonly = true;
			a[6].forEach(function(v) { o.depends('ipver', v); });
			o = ss.option(form.Value, a[1], a[3]);
			if (a[5])
				o.validate = a[5];
			else
				o.datatype = 'range(1,128)';
			o.modalonly = true;
			a[6].forEach(function(v) { o.depends('ipver', v); });
		});
		o = ss.option(form.Value, 'rate', _('Rate(kb/s)'));
		o.rmempty = false;
		o.validate = function(sid, v) {
			return (/^\d+$/.test(v || '') && +v > 0 && +v % 512 == 0) ? true
				: _('Speed rate %skbs is invalid! Please enter the multiple of 512!').format(v || '');
		};

		return m.render();
	},

	handleSave: function() {
		var self = this, m = this.map;
		return m.save().then(function() {
			var d = m.data, up = d.get('json', 'up'), down = d.get('json', 'down'), sh = d.get('json', 'shaping');
			var old = self.loaded.mib, mib, queues, dqueues, rules, tc, sum;

			mib = {
				ENABLE_QOS: flag(up.enable), QOS_POLICY: +up.policy || 0, TOTAL_BANDWIDTH_LIMIT: flag(up.limit),
				ENABLE_DSCP_MARK: flag(up.dscp), ENABLE_1P: +up.remark_1p || 0,
				ENABLE_DOWNSTREAM_QOS: flag(down.enable), QOS_DOWNSTREAM_POLICY: +down.policy || 0,
				TOTAL_DOWNSTREAM_BANDWIDTH_LIMIT: flag(down.limit), ENABLE_DOWNSTREAM_DSCP_MARK: flag(down.dscp),
				ENABLE_DOWNSTREAM_1P: +down.remark_1p || 0
			};
			/* Traffic Shaping's total bandwidth: a new value applies it and
			 * turns the limit on (stock "Apply"), an empty field clears it
			 * ("Clear"); the limit switches of the policy tabs are the same
			 * setting */
			[ [ 'up_bw', 'TOTAL_BANDWIDTH', 'TOTAL_BANDWIDTH_LIMIT' ],
			  [ 'down_bw', 'TOTAL_DOWNSTREAM_BANDWIDTH', 'TOTAL_DOWNSTREAM_BANDWIDTH_LIMIT' ] ].forEach(function(b) {
				var v = sh[b[0]] || '', was = old[b[2]] == '1' ? (old[b[1]] || '') : '';
				if (v !== '')
					mib[b[1]] = +v;
				if (v !== was)
					mib[b[2]] = v !== '' ? 1 : 0;
			});

			queues = d.sections('json', 'queue').map(function(r) {
				return { enable: flag(r.enable), weight: +r.weight || 0, car: +r.car || 0 };
			});
			dqueues = d.sections('json', 'dqueue').map(function(r) {
				return { enable: flag(r.enable), weight: +r.weight || 0, wifi: +r.wifi || 0 };
			});
			[ [ up, queues ], [ down, dqueues ] ].forEach(function(p) {
				if (p[0].enable != '1' || p[0].policy != '1')
					return;
				sum = p[1].reduce(function(t, q) { return t + (q.enable ? q.weight : 0); }, 0);
				if (sum != 100)
					throw new Error(_('Total WRR weight should be 100'));
			});

			rules = d.sections('json', 'rule').map(rulePayload);
			if (JSON.stringify(rules) == self.loaded.rules) {
				rules = undefined;
			} else {
				rules.forEach(function(r) {
					var e = ruleError(r);
					if (e)
						throw new Error('%s: %s'.format(r.name, e));
				});
				if (self.rulesMax && rules.length > self.rulesMax)
					throw new Error(_('the stock table holds %d rules').format(self.rulesMax));
			}
			tc = d.sections('json', 'tcrule').map(tcPayload);
			if (JSON.stringify(tc) == self.loaded.tc)
				tc = undefined;
			else if (self.tcMax && tc.length > self.tcMax)
				throw new Error(_('the stock table holds %d rules').format(self.tcMax));

			return nc.callQosSet(mib, queues, dqueues, rules, tc).then(function(r) {
				if (!r || r.error)
					throw new Error((r && r.error) || '?');
				ui.addNotification(null, E('p', nc.applyText(r, _('QoS settings saved.'))), 'info');
				return nc.reloadView(self);
			});
		}).catch(function(e) {
			ui.addNotification(null, E('p', _('Saving failed: %s').format(e.message || e)), 'danger');
		});
	},

	handleSaveApply: function() {
		return this.handleSave();
	},

	handleReset: null
});
