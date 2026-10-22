// SPDX-License-Identifier: Apache-2.0

'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require nijika.common as nc';

/*
 * Network > Wireless: the stock GUI's WLAN pages for both radios (wlan0
 * 5 GHz, wlan1 2.4 GHz), one tab each, plus EasyMesh:
 *   Radio     formWlanSetup (band, channel, width, power)
 *   SSIDs     formWlanSetup / formWlEncrypt / formFt: the records of
 *             WLAN_MBSSIB_TBL / WLAN1_MBSSIB_TBL (0 = main, 1-4 = guest;
 *             record 5, the repeater client, is not shown)
 *   Advanced  formAdvanceSetup (OFDMA, beacon, DTIM, WMM, multicast)
 *   WPS       formWsc (hostapd: wps_pbc / wps_pin)
 *   EasyMesh  formMultiAP (role, backhaul, pairing)
 * Backed by /etc/config/rtk: radio settings are MIB scalars (rtk.mib), the
 * SSIDs the table records. Save & Apply writes the changed fields and
 * restarts WiFi like the stock pages (config_WLAN). WPS and EasyMesh
 * buttons act on the running stack at once (rpcd nijika).
 *
 * Encodings (SDK mib.h, stock wlbasic.asp / fmwlan.c / hapd_conf.c):
 *   band   bits 1 b, 2 g, 4 a, 8 n, 64 ac, 128 ax (stock GUI: value - 1);
 *          a mode without the older bits refuses those clients (libmib
 *          writes /proc/net/rtk_wifi6/<if>/deny_legacy), e.g. 128 = WiFi 6
 *          only
 *   encrypt 0 none, 1 WEP, 4 WPA2, 6 WPA/WPA2, 16 WPA3, 20 WPA2+WPA3
 *   *CHANNELWIDTH 0 20, 1 40, 2 80, 3 160, 4 20-160 (2.4 GHz: 3 = 20/40)
 *   *RFPOWER_SCALE 0 100%, 1 70%, 2 50%, 3 35%, 4 15%
 *   802.11r: the stock hostapd config (libmib apply_11r, V1.1.2) adds
 *   FT-PSK / FT-SAE for WPA2, WPA/WPA2, WPA3 and WPA2+WPA3 SSIDs.
 *   BSS colouring is not in the stock configuration: nijika.wifi
 *   bss_color_<radio>, added to hostapd's config by /rtk/bin/hostapd.
 *   TWT: not available (the driver core reports no TWT support).
 *   Band steering (WIFI_STA_CONTROL: bit 0 on, bit 1 prefer 2.4 GHz) only
 *   works when both main SSIDs have the same name and security
 *   (rtk_wlan_get_band_steering_status); the stock stack turns it off
 *   itself otherwise. This page turns it on whenever they match.
 */

var RADIOS = [
	{ idx: 0, name: _('5 GHz'), tbl: 'WLAN_MBSSIB_TBL', chan: 'CHANNEL', auto: 'AUTO_CHANNEL', width: 'WLAN_CHANNELWIDTH',
	  power: 'WLAN_RFPOWER_SCALE', band: 'WLAN_BAND', ofdma: 'WLAN_OFDMA_ENABLED', beacon: 'BEACON_INTERVAL',
	  dtim: 'DTIM_PERIOD', wsc: 'WSC_DISABLE', ssid: 'SSID', encrypt: 'WLAN_ENCRYPT', psk: 'WLAN_WPA_PSK',
	  hide: 'HIDDEN_SSID',
	  channels: [ 36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165 ],
	  widths: [ [ '0', '20 MHz' ], [ '1', '40 MHz' ], [ '2', '80 MHz' ], [ '3', '160 MHz' ], [ '4', _('Auto (20-160 MHz)') ] ],
	  bands: [ [ '204', '802.11a/n/ac/ax' ], [ '200', _('802.11n/ac/ax (no 802.11a)') ], [ '192', '802.11ac/ax' ],
	           [ '128', _('802.11ax only (WiFi 6)') ], [ '76', '802.11a/n/ac' ], [ '12', '802.11a/n' ], [ '4', '802.11a' ] ] },
	{ idx: 1, name: _('2.4 GHz'), tbl: 'WLAN1_MBSSIB_TBL', chan: 'WLAN1_CHANNEL', auto: 'WLAN1_AUTO_CHANNEL', width: 'WLAN1_CHANNELWIDTH',
	  power: 'WLAN1_RFPOWER_SCALE', band: 'WLAN1_BAND', ofdma: 'WLAN1_OFDMA_ENABLED', beacon: 'WLAN1_BEACON_INTERVAL',
	  dtim: 'WLAN1_DTIM_PERIOD', wsc: 'WLAN1_WSC_DISABLE', ssid: 'WLAN1_SSID', encrypt: 'WLAN1_ENCRYPT', psk: 'WLAN1_WPA_PSK',
	  hide: 'WLAN1_HIDDEN_SSID',
	  channels: [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13 ],
	  widths: [ [ '0', '20 MHz' ], [ '1', '40 MHz' ], [ '3', '20/40 MHz' ] ],
	  bands: [ [ '139', '802.11b/g/n/ax' ], [ '138', _('802.11g/n/ax (no 802.11b)') ], [ '136', '802.11n/ax' ],
	           [ '128', _('802.11ax only (WiFi 6)') ], [ '11', '802.11b/g/n' ], [ '3', '802.11b/g' ] ] }
];

var SECURITY = [ [ '0', _('None (open)') ], [ '4', 'WPA2-PSK' ], [ '6', 'WPA/WPA2-PSK' ], [ '16', 'WPA3-SAE' ], [ '20', 'WPA2-PSK + WPA3-SAE' ] ];

/* EasyMesh backhaul BSS (multiap_bss_type) */
var MAP_BACKHAUL = 0x40;

/* What the stock formWlEncrypt derives from the method (PSK only):
 * ciphers, PMF (802.11w), SHA256, SAE PWE */
function securityFields(enc, pmf) {
	switch (enc) {
	case '4': return { wpaAuth: '2', unicastCipher: '0', wpa2UnicastCipher: '2', dotIEEE80211W: pmf || '1', sha256: pmf == '2' ? '1' : '0' };
	case '6': return { wpaAuth: '2', unicastCipher: '3', wpa2UnicastCipher: '3', dotIEEE80211W: '0', sha256: '0' };
	case '16': return { wpaAuth: '2', unicastCipher: '0', wpa2UnicastCipher: '2', dotIEEE80211W: '2', sha256: '1', sae_pwe: '2' };
	case '20': return { wpaAuth: '2', unicastCipher: '0', wpa2UnicastCipher: '2', dotIEEE80211W: '1', sha256: '0', sae_pwe: '2' };
	default: return { unicastCipher: '0', wpa2UnicastCipher: '0', dotIEEE80211W: '0', sha256: '0' };
	}
}

/* both main SSIDs alike: band steering possible */
function steerable() {
	var a = uci.get('rtk', 'WLAN_MBSSIB_TBL_0') || {}, b = uci.get('rtk', 'WLAN1_MBSSIB_TBL_0') || {};
	return a.ssid != null && a.ssid === b.ssid && a.encrypt === b.encrypt &&
		(a.encrypt == '0' || a.wpaPSK === b.wpaPSK);
}

function updateSteering() {
	var cur = +uci.get('rtk', 'mib', 'WIFI_STA_CONTROL') || 0;
	var want = steerable() ? (1 | (cur & 2)) : (cur & 2);
	if (want != cur)
		uci.set('rtk', 'mib', 'WIFI_STA_CONTROL', String(want));
}

function recIndex(sid) {
	return +String(sid).replace(/^.*_/, '');
}

function opt(s, name) {
	return s.children.filter(function(c) { return c.option == name; })[0];
}

function isBackhaul(sid) {
	return (+uci.get('rtk', sid, 'multiap_bss_type') & MAP_BACKHAUL) != 0;
}

/* an option on the MIB scalar rtk.mib.<key> inside a record section */
function mibOption(s, tab, cls, key, title, descr) {
	var o = s.taboption(tab, cls, '_m_' + key, title, descr);
	o.cfgvalue = function() { return uci.get('rtk', 'mib', key); };
	o.write = function(sid, val) { uci.set('rtk', 'mib', key, val); };
	o.remove = function() {};
	return o;
}

/* a field that is not saved with the form (buttons act on their own) */
function unsaved(o) {
	o.write = function() {};
	o.remove = function() {};
	return o;
}

function notify(r, okText) {
	if (r && r.ok)
		ui.addNotification(null, E('p', okText), 'info');
	else
		ui.addNotification(null, E('p', _('Failed: %s').format((r && r.error) || '?')), 'danger');
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('rtk'),
			L.resolveDefault(nc.callEasymeshGet(), {}),
			uci.load('nijika')
		]);
	},

	render: function(data) {
		var em = data[1] || {}, m, s, o;

		m = new form.Map('rtk', _('WLAN Configuration'),
			_('This page is used to configure the parameters for both radios, their SSIDs and EasyMesh, as the stock WLAN pages. Save & Apply restarts the WLAN (a few seconds without wireless).'));
		m.tabbed = true;
		this.map = m;

		RADIOS.forEach(function(r) {
			var axBands = new RegExp('^(' + r.bands.filter(function(b) { return +b[0] & 128; }).map(function(b) { return b[0]; }).join('|') + ')$');

			/* one tab per radio, on its main SSID record */
			s = m.section(form.NamedSection, r.tbl + '_0', r.tbl, r.name);
			s.tab('radio', _('Radio'));
			s.tab('ssids', _('SSIDs'));
			s.tab('advanced', _('Advanced'));
			s.tab('wps', _('WPS'));

			/* Radio */
			o = s.taboption('radio', form.Flag, '_on', _('Enable'), _('Off: the radio and all its SSIDs.'));
			o.rmempty = false;
			o.cfgvalue = function(sid) { return uci.get('rtk', sid, 'wlanDisabled') == '1' ? '0' : '1'; };
			o.write = function(sid, val) { uci.set('rtk', sid, 'wlanDisabled', val == '1' ? '0' : '1'); };

			o = mibOption(s, 'radio', form.ListValue, r.band, _('Mode'),
				_('Clients of a generation that is not listed cannot connect: without 802.11b no slow CCK rates; 802.11ax only admits WiFi 6 devices (many smart-home devices are 802.11n only, mostly on 2.4 GHz).'));
			r.bands.forEach(function(b) { o.value(b[0], b[1]); });
			var cur = uci.get('rtk', 'mib', r.band);
			if (cur != null && !r.bands.some(function(b) { return b[0] == cur; }))
				o.value(cur, _('Other (%s)').format(cur));
			/* stock formWlanSetup: the root's band goes to every SSID; no
			 * 802.11ax, no OFDMA */
			o.write = function(sid, val) {
				uci.set('rtk', 'mib', r.band, val);
				for (var i = 0; i <= 5; i++)
					if (uci.get('rtk', r.tbl + '_' + i) != null)
						uci.set('rtk', r.tbl + '_' + i, 'wlanBand', val);
				if (!(+val & 128))
					uci.set('rtk', 'mib', r.ofdma, '0');
			};

			o = s.taboption('radio', form.ListValue, '_chan', _('Channel'));
			o.value('0', _('Auto'));
			r.channels.forEach(function(c) { o.value(String(c)); });
			o.cfgvalue = function() {
				return uci.get('rtk', 'mib', r.auto) == '1' ? '0' : (uci.get('rtk', 'mib', r.chan) || '0');
			};
			o.write = function(sid, val) {
				uci.set('rtk', 'mib', r.auto, val == '0' ? '1' : '0');
				if (val != '0')
					uci.set('rtk', 'mib', r.chan, val);
			};
			o.remove = function() {};

			o = mibOption(s, 'radio', form.ListValue, r.width, _('Channel width'));
			r.widths.forEach(function(w) { o.value(w[0], w[1]); });
			var cw = uci.get('rtk', 'mib', r.width);
			if (cw != null && !r.widths.some(function(w) { return w[0] == cw; }))
				o.value(cw, _('Other (%s)').format(cw));

			o = mibOption(s, 'radio', form.ListValue, r.power, _('Transmit power'));
			[ '100%', '70%', '50%', '35%', '15%' ].forEach(function(p, i) { o.value(String(i), p); });

			/* SSIDs */
			o = s.taboption('ssids', form.SectionValue, '_ssids', form.GridSection, r.tbl);
			var ss = o.subsection;
			ss.anonymous = true;
			ss.addremove = false;
			ss.nodescriptions = true;
			ss.filter = function(sid) { return recIndex(sid) <= 4; };
			ss.modaltitle = function(sid) {
				return '%s %s'.format(r.name, recIndex(sid) ? _('guest SSID %d').format(recIndex(sid)) : _('main SSID'));
			};
			ss.tab('general', _('General'));
			ss.tab('security', _('Security'));
			ss.tab('roaming', _('Roaming'));

			o = ss.option(form.DummyValue, '_which', _('SSID'));
			o.cfgvalue = function(sid) {
				var t = recIndex(sid) ? _('Guest %d').format(recIndex(sid)) : _('Main');
				return isBackhaul(sid) ? _('%s (EasyMesh backhaul)').format(t) : t;
			};

			o = ss.taboption('general', form.Value, 'ssid', _('Name'));
			o.datatype = 'maxlength(32)';
			o.rmempty = false;
			o.write = function(sid, val) {
				uci.set('rtk', sid, 'ssid', val);
				if (recIndex(sid) == 0)
					uci.set('rtk', 'mib', r.ssid, val);	/* the stock GUI keeps both */
			};

			o = ss.taboption('general', form.Flag, '_on', _('Enabled'));
			o.rmempty = false;
			o.cfgvalue = function(sid) { return uci.get('rtk', sid, 'wlanDisabled') == '1' ? '0' : '1'; };
			o.write = function(sid, val) { uci.set('rtk', sid, 'wlanDisabled', val == '1' ? '0' : '1'); };

			o = ss.taboption('general', form.Flag, 'hidessid', _('Hide SSID'));
			o.modalonly = true;
			o.rmempty = false;
			o.write = function(sid, val) {
				uci.set('rtk', sid, 'hidessid', val);
				if (recIndex(sid) == 0)
					uci.set('rtk', 'mib', r.hide, val);
			};

			o = ss.taboption('general', form.Flag, 'userIsolation', _('Client isolation'), _('Clients of this SSID cannot reach each other.'));
			o.modalonly = true;
			o.rmempty = false;

			o = ss.taboption('general', form.DummyValue, '_backhaul', ' ');
			o.modalonly = true;
			o.cfgvalue = function(sid) {
				return isBackhaul(sid) ? _('EasyMesh uses this SSID to link the mesh nodes; the stock stack manages it.') : '';
			};

			o = ss.taboption('security', form.ListValue, 'encrypt', _('Security'));
			SECURITY.forEach(function(e) { o.value(e[0], e[1]); });
			o.rmempty = false;
			o.write = function(sid, val) {
				var pmfOpt = opt(this.section, 'dotIEEE80211W');
				var f = securityFields(val, pmfOpt && pmfOpt.isActive(sid) ? pmfOpt.formvalue(sid) : null);
				uci.set('rtk', sid, 'encrypt', val);
				Object.keys(f).forEach(function(k) { uci.set('rtk', sid, k, f[k]); });
				if (recIndex(sid) == 0)
					uci.set('rtk', 'mib', r.encrypt, val);
			};
			o.textvalue = function(sid) {
				var v = uci.get('rtk', sid, 'encrypt');
				var e = SECURITY.filter(function(x) { return x[0] == v; })[0];
				return e ? e[1] : (v == '1' ? 'WEP' : v);
			};

			o = ss.taboption('security', form.Value, 'wpaPSK', _('Password'), _('8 to 63 characters (or 64 hex digits).'));
			o.modalonly = true;
			o.password = true;
			o.depends('encrypt', /^(4|6|16|20)$/);
			o.validate = function(sid, v) {
				return (v.length >= 8 && v.length <= 63) || /^[0-9a-fA-F]{64}$/.test(v) ? true : _('8 to 63 characters');
			};
			o.write = function(sid, val) {
				uci.set('rtk', sid, 'wpaPSK', val);
				if (recIndex(sid) == 0)
					uci.set('rtk', 'mib', r.psk, val);
			};

			o = ss.taboption('security', form.ListValue, 'dotIEEE80211W', _('Management frame protection'),
				_('802.11w. WPA3 always requires it, WPA2+WPA3 makes it optional.'));
			o.modalonly = true;
			o.value('0', _('Off'));
			o.value('1', _('Optional'));
			o.value('2', _('Required'));
			o.depends('encrypt', '4');
			o.write = function(sid, val) {
				uci.set('rtk', sid, 'dotIEEE80211W', val);
				uci.set('rtk', sid, 'sha256', val == '2' ? '1' : '0');
			};

			o = ss.taboption('security', form.Value, 'wpaGroupRekeyTime', _('Group key interval (s)'),
				_('How often the broadcast key is renewed; 0 = never.'));
			o.modalonly = true;
			o.datatype = 'uinteger';
			o.depends('encrypt', /^(4|6|16|20)$/);

			o = ss.taboption('roaming', form.Flag, 'WLAN_FT_ENABLE', _('802.11r fast roaming'),
				_('Fast BSS transition between access points of this SSID (EasyMesh nodes): FT-PSK for WPA2, FT-SAE for WPA3.'));
			o.modalonly = true;
			o.rmempty = false;
			o = ss.taboption('roaming', form.Value, 'WLAN_FT_MDID', _('Mobility domain'), _('4 hex digits, the same on every access point.'));
			o.modalonly = true;
			o.datatype = 'and(hexstring,rangelength(4,4))';
			o.depends('WLAN_FT_ENABLE', '1');
			o = ss.taboption('roaming', form.Flag, 'WLAN_FT_OVER_DS', _('FT over DS'), _('Roam through the current access point.'));
			o.modalonly = true;
			o.rmempty = false;
			o.depends('WLAN_FT_ENABLE', '1');
			o = ss.taboption('roaming', form.Flag, 'rm_activated', _('802.11k'), _('Neighbour reports for roaming clients.'));
			o.modalonly = true;
			o.rmempty = false;
			o = ss.taboption('roaming', form.Flag, 'BssTransEnable', _('802.11v'), _('BSS transition management (steering).'));
			o.modalonly = true;
			o.rmempty = false;

			o = ss.option(form.DummyValue, '_ft', _('802.11r'));
			o.cfgvalue = function(sid) {
				if (uci.get('rtk', sid, 'WLAN_FT_ENABLE') != '1')
					return _('off');
				return /^(4|6|16|20)$/.test(uci.get('rtk', sid, 'encrypt')) ? _('on') : _('on (needs WPA2/WPA3)');
			};

			ss.children.forEach(function(c) { c.retain = true; });

			/* Advanced */
			o = mibOption(s, 'advanced', form.Flag, r.ofdma, _('OFDMA'),
				_('802.11ax multi-user transmission: several clients share one transmission. Needs an 802.11ax mode.'));
			o.rmempty = false;
			o.depends('_m_' + r.band, axBands);

			o = s.taboption('advanced', form.Flag, '_bss_color', _('BSS colouring'),
				_('802.11ax: marks this network\'s frames with a colour (from the radio\'s MAC address), so clients and nearby WiFi 6 networks can reuse the channel instead of backing off. The stock firmware leaves it off.'));
			o.rmempty = false;
			o.cfgvalue = function() { return uci.get('nijika', 'wifi', 'bss_color_wlan' + r.idx) == '0' ? '0' : '1'; };
			o.write = function(sid, val) { uci.set('nijika', 'wifi', 'bss_color_wlan' + r.idx, val); };
			o.remove = function() {};
			o.depends('_m_' + r.band, axBands);

			o = s.taboption('advanced', form.Flag, 'wmmEnabled', _('WMM'), _('Wi-Fi multimedia (QoS); 802.11n and newer need it.'));
			o.rmempty = false;
			o = s.taboption('advanced', form.Flag, '_mc2u', _('Multicast to unicast'),
				_('Sends multicast (IPTV) to each WiFi client as unicast, at the client\'s own rate.'));
			o.rmempty = false;
			o.cfgvalue = function(sid) { return uci.get('rtk', sid, 'mc2u_disable') == '1' ? '0' : '1'; };
			o.write = function(sid, val) { uci.set('rtk', sid, 'mc2u_disable', val == '1' ? '0' : '1'); };

			o = s.taboption('advanced', form.DummyValue, '_steer', _('Band steering'));
			o.cfgvalue = function() {
				return steerable()
					? _('on: both bands have the same name and password, dual-band clients are steered to the preferred band')
					: _('off: give the 5 GHz and 2.4 GHz main SSIDs the same name and password to turn it on');
			};
			if (r.idx == 0) {
				o = s.taboption('advanced', form.ListValue, '_steer_pref', _('Preferred band'), _('Used while band steering is on.'));
				o.value('5', _('5 GHz'));
				o.value('2', _('2.4 GHz'));
				o.cfgvalue = function() { return (+uci.get('rtk', 'mib', 'WIFI_STA_CONTROL') & 2) ? '2' : '5'; };
				o.write = function(sid, val) {
					var v = +uci.get('rtk', 'mib', 'WIFI_STA_CONTROL') || 0;
					uci.set('rtk', 'mib', 'WIFI_STA_CONTROL', String(val == '2' ? (v | 2) : (v & ~2)));
				};
				o.remove = function() {};
			}

			o = mibOption(s, 'advanced', form.Value, r.beacon, _('Beacon interval (ms)'));
			o.datatype = 'range(20,1024)';
			o = mibOption(s, 'advanced', form.Value, r.dtim, _('DTIM period'));
			o.datatype = 'range(1,255)';

			/* WPS */
			o = s.taboption('wps', form.Flag, '_wps', _('Enable WPS'),
				_('Wi-Fi Protected Setup on the main SSID. Not with WEP or WPA3-only security.'));
			o.rmempty = false;
			o.cfgvalue = function(sid) { return uci.get('rtk', sid, 'wsc_disabled') == '1' ? '0' : '1'; };
			o.write = function(sid, val) {
				var off = val == '1' ? '0' : '1';
				uci.set('rtk', sid, 'wsc_disabled', off);
				uci.set('rtk', 'mib', r.wsc, off);
			};

			o = unsaved(s.taboption('wps', form.Button, '_wps_pbc', _('Push button'),
				_('Then press the WPS button on the device within two minutes. WPS must be enabled and saved.')));
			o.inputtitle = _('Start PBC');
			o.inputstyle = 'apply';
			o.onclick = function() {
				return nc.callWps(r.idx, 'pbc', '').then(function(res) { notify(res, _('%s: WPS push button active for two minutes.').format(r.name)); });
			};

			o = unsaved(s.taboption('wps', form.Value, '_wps_pin', _('Client PIN'), _('The PIN the device shows (4 or 8 digits).')));
			o.datatype = 'or(rangelength(4,4),rangelength(8,8))';
			o.cfgvalue = function() { return ''; };

			o = unsaved(s.taboption('wps', form.Button, '_wps_pinstart', ' '));
			o.inputtitle = _('Start PIN');
			o.onclick = function(ev, sid) {
				var w = this.section.getUIElement(sid, '_wps_pin'), pin = w ? String(w.getValue()).trim() : '';
				if (!/^(\d{4}|\d{8})$/.test(pin)) {
					ui.addNotification(null, E('p', _('The PIN has 4 or 8 digits.')), 'warning');
					return;
				}
				return nc.callWps(r.idx, 'pin', pin).then(function(res) { notify(res, _('%s: waiting for the device with that PIN.').format(r.name)); });
			};

			o = unsaved(s.taboption('wps', form.Button, '_wps_cancel', ' '));
			o.inputtitle = _('Cancel WPS');
			o.inputstyle = 'reset';
			o.onclick = function() {
				return nc.callWps(r.idx, 'cancel', '').then(function(res) { notify(res, _('%s: WPS stopped.').format(r.name)); });
			};

			s.children.forEach(function(c) { c.retain = true; });
		});

		/* EasyMesh: applied with its own button (the stock stack sets up
		 * roles, backhaul SSID and 802.11k/v itself) */
		s = m.section(form.NamedSection, 'mib', 'mib', _('EasyMesh'),
			_('Wi-Fi EasyMesh joins mesh access points (satellites) to this router: they take over its SSIDs, and clients roam between them. As the controller this router enables 802.11k/v on every SSID, and the stock stack sets up a backhaul SSID for the satellites. NijikaWrt keeps the chosen role at every boot.'));

		o = s.option(form.DummyValue, '_em_state', _('Status'));
		o.cfgvalue = function() {
			var run = L.toArray(em.running);
			return '%s; %s'.format({ disabled: _('disabled'), controller: _('controller'), agent: _('agent'), auto: _('auto') }[em.role] || '?',
				run.length ? _('running: %s').format(run.join(', ')) : _('no mesh daemon running'));
		};

		o = unsaved(s.option(form.ListValue, '_em_role', _('Role'),
			_('Auto is the D-Link / TM default for a spare unit: with no fibre, its WPS button turns it into a mesh node (satellite), whose LAN is a DHCP client without a DHCP server. Not for the router that serves the LAN.')));
		o.value('controller', _('Controller'));
		o.value('disabled', _('Disabled'));
		o.value('auto', _('Auto (D-Link/TM: mesh node without fibre)'));
		if (em.role == 'agent')
			o.value('agent', _('Agent / mesh node (set on the stock GUI or by the WPS button)'));
		o.cfgvalue = function() { return em.role || 'disabled'; };

		o = unsaved(s.option(form.ListValue, '_em_backhaul', _('Backhaul'), _('Radio the satellites connect over.')));
		o.value('3', _('Auto'));
		o.value('0', _('5 GHz'));
		o.value('1', _('2.4 GHz'));
		o.cfgvalue = function() { return '3'; };
		o.depends('_em_role', 'controller');

		o = unsaved(s.option(form.Value, '_em_name', _('Device name')));
		o.datatype = 'maxlength(32)';
		o.cfgvalue = function() { return em.name || ''; };

		o = unsaved(s.option(form.Button, '_em_apply', ' '));
		o.inputtitle = _('Apply EasyMesh');
		o.inputstyle = 'apply';
		o.onclick = function(ev, sid) {
			var sec = this.section, val = function(n) { var w = sec.getUIElement(sid, n); return w ? w.getValue() : null; };
			var role = val('_em_role');
			if (role == 'agent')
				return;
			return nc.callEasymeshSet(role, val('_em_backhaul') || '3', val('_em_name') || '').then(function(res) {
				notify(res, _('EasyMesh set to %s; WiFi restarts.').format(role));
			});
		};

		o = unsaved(s.option(form.Button, '_em_pair', _('Pairing'),
			_('Then press the WPS (pairing) button on the satellite within two minutes.')));
		o.inputtitle = _('Start pairing');
		o.onclick = function() {
			return nc.callEasymeshPair().then(function(res) { notify(res, _('EasyMesh pairing started.')); });
		};
		o.depends('_em_role', 'controller');

		s.children.forEach(function(c) { c.retain = true; });

		return m.render();
	},

	/* band steering follows the main SSIDs (after the fields are parsed) */
	handleSave: function() {
		return this.map.save(function() { updateSteering(); });
	},

	handleSaveApply: function(ev, mode) {
		nc.reloadAfterApply(this, 'rtk');
		return this.super('handleSaveApply', [ ev, mode ]);
	}
});
