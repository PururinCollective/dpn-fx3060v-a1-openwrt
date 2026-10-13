'use strict';
'require view';
'require form';
'require ui';
'require nijika.common as nc';

/*
 * Quick Setup: PON authentication, PPPoE Internet WAN, WiFi and VoIP.
 * Values are written to the stock MIB (flash set / voipflashcmd); the stock
 * stack applies them after a reboot.
 */

function wanLabel(rec, idx) {
	var mode = { 0: 'Bridge', 1: 'IPoE', 2: 'PPPoE' }[rec.ChannelMode] || ('mode ' + rec.ChannelMode);
	var vid = (rec.vlan == '1' && rec.vid) ? 'VLAN ' + rec.vid : _('untagged');
	var name = rec.WanName ? ' "' + rec.WanName + '"' : '';
	var user = rec.pppUser ? ' (' + rec.pppUser + ')' : '';
	return '#%d%s %s, %s%s'.format(idx, name, mode, vid, user);
}

return view.extend({
	load: function() {
		return nc.callQuickGet();
	},

	render: function(qs) {
		if (!qs || qs.error)
			return E('p', { 'class': 'alert-message warning' }, (qs && qs.error) || _('Vendor stack not available'));

		var recs = (qs.wan && qs.wan.records) || [],
		    presets = qs.isp || [],
		    wanIdx = 0;

		for (var i = 0; i < recs.length; i++)
			if (recs[i].ChannelMode == '2') { wanIdx = i; break; }

		var cur = recs[wanIdx] || {};
		this.recs = recs;
		this.orig = {
			ploam: qs.pon.ploam, loid: qs.pon.loid, loid_pw: qs.pon.loid_pw
		};

		var data = {
			pon: { sn: qs.pon.sn, ploam: qs.pon.ploam, loid: qs.pon.loid, loid_pw: qs.pon.loid_pw },
			wan: {
				index: String(wanIdx), isp: '',
				user: cur.pppUser || '', pass: cur.pppPasswd || '',
				vid: (cur.vlan == '1') ? (cur.vid || '') : '0',
				prio: cur.vprio || '0', mtu: cur.MTU || ''
			}
		};
		(qs.wifi || []).forEach(function(w) {
			data['wifi' + w.radio] = { ssid: w.ssid, key: w.key, band: w.band };
		});
		(qs.voip || []).forEach(function(v) {
			data['voip' + v.line] = {
				enable: v.enable ? '1' : '0', addr: v.addr, port: v.port, domain: v.domain,
				number: v.number, login: v.login, password: v.password, display: v.display
			};
		});

		var m, s, o;
		m = new form.JSONMap(data, _('Quick Setup'),
			_('Get the built-in ONT online in one step. Settings are stored in the stock configuration and take effect after a reboot.'));
		this.map = m;

		/* PON */
		s = m.section(form.NamedSection, 'pon', 'pon', _('PON authentication'),
			_('Most ISPs register the ONT by serial number; some also need the PLOAM password or LOID.'));
		o = s.option(form.Value, 'sn', _('GPON serial number'), _('4 vendor letters + 8 hex digits, e.g. DLKI34615A2E'));
		o.validate = function(id, v) {
			return /^[A-Za-z0-9]{4}[0-9A-Fa-f]{8}$/.test(v) ? true : _('Expected 4 characters + 8 hex digits');
		};
		o = s.option(form.Value, 'ploam', _('PLOAM password'), _('Up to 10 characters for GPON.'));
		o.password = true;
		o.datatype = 'maxlength(36)';
		o.rmempty = false;
		o = s.option(form.Value, 'loid', _('LOID'));
		o.optional = true;
		o = s.option(form.Value, 'loid_pw', _('LOID password'));
		o.password = true;
		o.optional = true;

		/* WAN */
		s = m.section(form.NamedSection, 'wan', 'wan', _('Internet (PPPoE)'),
			_('Edits an existing WAN connection of the stock configuration.'));
		o = s.option(form.ListValue, 'index', _('WAN connection'));
		recs.forEach(function(r, idx) { o.value(String(idx), wanLabel(r, idx)); });
		o.onchange = L.bind(function(ev, sid, value) {
			var r = this.recs[+value] || {};
			this.setField('wan', 'user', r.pppUser || '');
			this.setField('wan', 'pass', r.pppPasswd || '');
			this.setField('wan', 'vid', (r.vlan == '1') ? (r.vid || '') : '0');
			this.setField('wan', 'prio', r.vprio || '0');
			this.setField('wan', 'mtu', r.MTU || '');
		}, this);

		o = s.option(form.ListValue, 'isp', _('ISP preset'), _('Fills in VLAN, priority and MTU.'));
		o.value('', _('-- custom --'));
		presets.forEach(function(p) { o.value(p.id, '%s (VLAN %d)'.format(p.label, p.vid)); });
		o.onchange = L.bind(function(ev, sid, value) {
			var p = presets.filter(function(p) { return p.id == value; })[0];
			if (!p)
				return;
			this.setField('wan', 'vid', String(p.vid));
			this.setField('wan', 'prio', String(p.prio));
			this.setField('wan', 'mtu', String(p.mtu));
		}, this);

		o = s.option(form.Value, 'user', _('PPPoE username'));
		o = s.option(form.Value, 'pass', _('PPPoE password'));
		o.password = true;
		o = s.option(form.Value, 'vid', _('VLAN ID'), _('0 = untagged'));
		o.datatype = 'range(0,4094)';
		o = s.option(form.ListValue, 'prio', _('802.1p priority'));
		for (var p = 0; p <= 7; p++)
			o.value(String(p));
		o = s.option(form.Value, 'mtu', _('MTU'));
		o.datatype = 'range(576,1500)';
		o.placeholder = '1492';

		/* WiFi */
		[ 0, 1 ].forEach(function(r) {
			var w = data['wifi' + r];
			if (!w)
				return;
			s = m.section(form.NamedSection, 'wifi' + r, 'wifi' + r,
				_('WiFi %s').format(w.band == '5g' ? '5 GHz' : '2.4 GHz') + ' (wlan' + r + ')');
			o = s.option(form.Value, 'ssid', _('Network name (SSID)'));
			o.datatype = 'maxlength(32)';
			o.rmempty = false;
			o = s.option(form.Value, 'key', _('WPA2/WPA3 key'));
			o.password = true;
			o.datatype = 'rangelength(8,64)';
		});

		/* VoIP */
		[ 0, 1 ].forEach(function(l) {
			if (!data['voip' + l])
				return;
			s = m.section(form.NamedSection, 'voip' + l, 'voip' + l, _('VoIP line %d (phone port %d)').format(l + 1, l + 1));
			o = s.option(form.Flag, 'enable', _('Enable SIP account'));
			o = s.option(form.Value, 'addr', _('SIP server / proxy'));
			o.depends('enable', '1');
			o.datatype = 'host';
			o = s.option(form.Value, 'port', _('SIP port'));
			o.depends('enable', '1');
			o.datatype = 'port';
			o.placeholder = '5060';
			o = s.option(form.Value, 'domain', _('SIP domain'));
			o.depends('enable', '1');
			o = s.option(form.Value, 'number', _('Phone number'));
			o.depends('enable', '1');
			o = s.option(form.Value, 'login', _('Authentication user'));
			o.depends('enable', '1');
			o = s.option(form.Value, 'password', _('Authentication password'));
			o.depends('enable', '1');
			o.password = true;
			o = s.option(form.Value, 'display', _('Display name'));
			o.depends('enable', '1');
			o.optional = true;
		});

		return m.render().then(function(node) {
			return E([], [ nc.style(), node ]);
		});
	},

	setField: function(section, option, value) {
		var opt = this.map.lookupOption(option, section);
		if (opt && opt[0])
			opt[0].getUIElement(opt[1]).setValue(value);
	},

	collect: function() {
		var m = this.map, d = function(s, o) { return m.data.get('json', s, o); };
		var pon = {
			sn: d('pon', 'sn'),
			ploam: d('pon', 'ploam') || '',
			ploam_set: (d('pon', 'ploam') || '') != (this.orig.ploam || ''),
			loid: d('pon', 'loid') || '',
			loid_pw: d('pon', 'loid_pw') || '',
			loid_set: ((d('pon', 'loid') || '') != (this.orig.loid || '')) ||
			          ((d('pon', 'loid_pw') || '') != (this.orig.loid_pw || ''))
		};
		var wan = {
			index: +d('wan', 'index'),
			user: d('wan', 'user') || '',
			pass: d('wan', 'pass') || '',
			vid: d('wan', 'vid') || '0',
			prio: d('wan', 'prio') || '0',
			mtu: d('wan', 'mtu') || ''
		};
		var wifi = [], voip = [];
		[ 0, 1 ].forEach(function(r) {
			if (m.data.get('json', 'wifi' + r))
				wifi.push({ radio: r, ssid: d('wifi' + r, 'ssid') || '', key: d('wifi' + r, 'key') || '' });
			if (m.data.get('json', 'voip' + r))
				voip.push({
					line: r, enable: d('voip' + r, 'enable') == '1' ? 1 : 0,
					addr: d('voip' + r, 'addr') || '', port: d('voip' + r, 'port') || '',
					domain: d('voip' + r, 'domain') || '', number: d('voip' + r, 'number') || '',
					login: d('voip' + r, 'login') || '', password: d('voip' + r, 'password') || '',
					display: d('voip' + r, 'display') || ''
				});
		});
		return [ pon, wan, wifi, voip ];
	},

	handleSave: function(ev) {
		return this.map.save().then(L.bind(function() {
			var a = this.collect();
			return nc.callQuickSet(a[0], a[1], a[2], a[3]);
		}, this)).then(function(res) {
			if (res && res.error)
				throw new Error(res.error);
			ui.addNotification(null, E('p', _('Quick Setup saved to the stock configuration. Reboot to apply.')), 'info');
			return res;
		}).catch(function(e) {
			ui.addNotification(null, E('p', _('Saving failed: %s').format(e.message || e)), 'danger');
			throw e;
		});
	},

	handleSaveApply: function(ev) {
		return this.handleSave(ev).then(function() {
			nc.rebootPrompt(nc);
		});
	},

	handleReset: null
});
