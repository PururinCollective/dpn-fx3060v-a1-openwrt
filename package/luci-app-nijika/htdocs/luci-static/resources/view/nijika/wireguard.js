// SPDX-License-Identifier: Apache-2.0

'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require poll';
'require nijika.common as nc';

/*
 * Services > WireGuard: one interface, wg0, run by
 * /usr/libexec/nijika/wireguard from nijika.wireguard and the
 * wireguard_peer sections, with the module NijikaWrt builds for the stock
 * kernel. A new peer gets a key pair, a preshared key and the next free
 * tunnel address; when its private key stays here, the page shows its
 * client configuration and QR code. Endpoint for clients: the DDNS name,
 * else the WAN's public address, else (CGNAT) an IPv6 address.
 */

function ip4(s) {
	var m = String(s || '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	return m ? ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4] : null;
}

function ip4str(n) {
	return [ n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255 ].join('.');
}

function list(v) {
	return L.toArray(v).join(' ').split(/[\s,]+/).filter(function(x) { return x != ''; });
}

/* the first unused host address in wg0's first IPv4 subnet, as /32 (a /32
 * tunnel address: in the /24 around it) */
function nextAddress() {
	var addrs = list(uci.get('nijika', 'wireguard', 'address')), used = {}, net, len, base, i;
	for (i = 0; i < addrs.length && net == null; i++) {
		var m = addrs[i].match(/^([\d.]+)\/(\d+)$/);
		if (m && ip4(m[1]) != null) {
			net = ip4(m[1]);
			len = +m[2];
			used[net] = true;
		}
	}
	if (net == null)
		return null;
	if (len > 30)
		len = 24;
	uci.sections('nijika', 'wireguard_peer').forEach(function(p) {
		list(p.allowed_ips).forEach(function(a) {
			var n = ip4(a.replace(/\/32$/, ''));
			if (n != null)
				used[n] = true;
		});
	});
	base = (net & (len ? (0xffffffff << (32 - len)) >>> 0 : 0)) >>> 0;
	for (i = 1; i < Math.pow(2, 32 - len) - 1; i++)
		if (!used[(base + i) >>> 0])
			return ip4str((base + i) >>> 0) + '/32';
	return null;
}

var KEY_RE = /^[A-Za-z0-9+\/]{42}[AEIMQUYcgkosw480]=$/;

/* a WireGuard key option: pasted keys (WinBox, wg show) may carry blanks */
function keyOption(o, required) {
	o.validate = function(sid, v) {
		v = String(v || '').trim();
		if (!v)
			return required ? _('Required') : true;
		return KEY_RE.test(v) ? true : _('Not a WireGuard key (44 characters of base64, ending in =)');
	};
	o.write = function(sid, v) {
		return form.Value.prototype.write.call(this, sid, String(v || '').trim());
	};
	return o;
}

function ago(st, t) {
	var d = (+st.now || 0) - (+t || 0);
	if (!+t)
		return _('never');
	if (d < 60)
		return _('%d s ago').format(Math.max(d, 0));
	if (d < 3600)
		return _('%d min ago').format(Math.floor(d / 60));
	if (d < 86400)
		return _('%d h %d min ago').format(Math.floor(d / 3600), Math.floor(d % 3600 / 60));
	return _('%d days ago').format(Math.floor(d / 86400));
}

function peerState(st, sid) {
	var pub = uci.get('nijika', sid, 'public_key'), p = (st.peers || {})[pub];

	if (uci.get('nijika', sid, 'enabled') == '0')
		return E('em', {}, _('Disabled'));
	if (!st.up)
		return E('em', {}, _('Interface down'));
	if (!p)
		return E('em', {}, _('Not active (Save & Apply?)'));
	/* a handshake every 2 minutes while traffic flows */
	var fresh = +p.latest_handshake && (+st.now - +p.latest_handshake) < 180;
	return E('span', { 'style': fresh ? 'color:#1f9d55' : '' }, [
		_('Handshake %s').format(ago(st, p.latest_handshake)),
		E('br'),
		E('small', {}, '↓ %1024mB ↑ %1024mB'.format(+p.rx, +p.tx)),
		p.endpoint ? E('small', {}, ' · ' + p.endpoint) : ''
	]);
}

function endpointText(st) {
	if (!st.endpoint)
		return E('em', {}, _('none: set one below (client configurations need it)'));
	var src = {
		setting: _('setting below'),
		ddns: _('DDNS host name'),
		wan: _('the WAN\'s public address'),
		ipv6: _('an IPv6 address of the router (no public IPv4)')
	}[st.endpoint_source] || '';
	return E([], [ E('code', {}, '%s:%d'.format(st.endpoint.indexOf(':') >= 0 ? '[' + st.endpoint + ']' : st.endpoint, +st.listen_port)),
		src ? ' (' + src + ')' : '' ]);
}

function statusBox(st) {
	var rows = [], notes = [];

	if (!st.module_available)
		notes.push(E('div', { 'class': 'alert-message danger' },
			_('This image has no WireGuard module for the running kernel %s.').format(st.kernel || '?')));
	else if (st.error)
		notes.push(E('div', { 'class': 'alert-message danger' }, _('WireGuard did not start: %s').format(st.error)));

	rows.push([ _('Interface'), st.up ? E('span', { 'style': 'color:#1f9d55' }, _('wg0 up')) :
		E('em', {}, st.enabled ? _('wg0 down') : _('off')) ]);
	rows.push([ _('Public key'), st.public_key ? E('code', { 'style': 'word-break:break-all' }, st.public_key) : E('em', {}, _('generated at the first start')) ]);
	rows.push([ _('Endpoint for clients'), endpointText(st) ]);

	if (st.wan_kind == 'cgnat' || st.wan_kind == 'private' || st.wan_kind == 'reserved')
		notes.push(E('div', { 'class': 'alert-message warning' }, [
			E('strong', {}, st.wan_kind == 'cgnat' ? _('Behind carrier-grade NAT (CGNAT).') : _('No public IPv4 address.')), ' ',
			_('Peers cannot reach this router over IPv4: the WAN\'s address is not public, and the ISP\'s NAT does not forward UDP port %d. Use IPv6 (the client network needs it): client configurations then carry an IPv6 address of the router, or set a DDNS name with an AAAA record as endpoint. Otherwise only this router can call out to a peer with a public address (site-to-site: set that peer\'s endpoint and a keepalive).')
				.format(+st.listen_port)
		]));

	return E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, _('Status')),
		E('table', { 'class': 'table' }, rows.map(function(r) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'width': '25%' }, r[0]),
				E('td', { 'class': 'td left' }, r[1])
			]);
		}))
	].concat(notes));
}

/* client configuration and QR code of a peer whose key pair is kept here */
function showClient(sid) {
	var st = uci.state || {}, pending = [ 'creates', 'changes', 'deletes' ].some(function(k) {
		return st[k] && st[k].nijika && (st[k].nijika[sid] || st[k].nijika.wireguard);
	});
	if (pending) {
		ui.addNotification(null, E('p', _('Save & Apply first: the configuration is made from the applied settings.')), 'warning');
		return;
	}
	return nc.callWgClient(sid).then(function(r) {
		if (!r || r.error)
			throw new Error((r && r.error) || '?');
		var name = (uci.get('nijika', sid, 'description') || 'peer').replace(/[^A-Za-z0-9_-]+/g, '_'),
		    file = 'data:text/plain;charset=utf-8,' + encodeURIComponent(r.config + '\n'),
		    qr = r.qr ? 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(r.qr))) : null;
		ui.showModal(_('Client configuration: %s').format(uci.get('nijika', sid, 'description') || sid), [
			E('p', {}, _('Scan the QR code with the WireGuard app, or import the file. It holds the peer\'s private key: share it only with that device.')),
			qr ? E('div', { 'style': 'text-align:center' }, E('img', { 'src': qr, 'alt': 'QR', 'style': 'width:280px;max-width:100%;background:#fff;padding:8px' })) : '',
			E('pre', { 'class': 'nijika-pre', 'style': 'user-select:all' }, r.config),
			E('div', { 'class': 'right' }, [
				E('a', { 'class': 'btn cbi-button', 'href': file, 'download': 'wg-%s.conf'.format(name) }, _('Download .conf')),
				' ',
				E('button', { 'class': 'btn cbi-button-action', 'click': ui.hideModal }, _('Close'))
			])
		]);
	}).catch(function(e) {
		ui.addNotification(null, E('p', _('No configuration: %s').format(e.message || e)), 'danger');
	});
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('nijika'),
			L.resolveDefault(nc.callWgStatus(), {})
		]);
	},

	render: function(data) {
		var self = this, m, s, o;

		this.st = data[1] || {};

		m = new form.Map('nijika', _('WireGuard'),
			_('This page is used to configure the WireGuard VPN of the router (interface wg0). Remote clients reach the LAN and the Internet through it, and other sites can be linked. A peer has the access of a LAN device. The stock kernel has no WireGuard; NijikaWrt builds the module for it.'));

		s = m.section(form.NamedSection, 'wireguard', 'wireguard', _('Interface'));
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('Enable'));
		o.rmempty = false;

		o = s.option(form.Value, 'listen_port', _('Listen port'), _('UDP; opened in the stock firewall (IPv4 and IPv6).'));
		o.datatype = 'port';
		o.placeholder = '51820';
		o.rmempty = false;

		o = s.option(form.DynamicList, 'address', _('Tunnel address'),
			_('The router\'s address in the tunnel, with the tunnel\'s subnet (e.g. <code>10.7.0.1/24</code>; an IPv6 ULA like <code>fd07::1/64</code> may be added). Pick a subnet not used on the LAN or at the peers.'));
		o.datatype = 'cidr';
		o.rmempty = false;

		o = s.option(form.Value, 'private_key', _('Private key'),
			_('Generated at the first start. A new key makes every peer\'s configuration invalid: they need the new public key.'));
		o.password = true;
		o.placeholder = _('generated');
		keyOption(o, false);

		o = s.option(form.Value, 'mtu', _('MTU'), _('Empty: the WAN\'s MTU - 80 (1412 with PPPoE).'));
		o.datatype = 'range(1280,1420)';
		o.placeholder = _('automatic');

		o = s.option(form.Value, 'endpoint', _('Endpoint for clients'),
			_('Host name or address client configurations connect to. Empty: the first DDNS host name (Services > DDNS), else the WAN\'s public IPv4 address, else an IPv6 address of the router.'));
		o.datatype = 'host';
		o.placeholder = _('automatic');

		o = s.option(form.Value, 'dns', _('DNS for clients'),
			_('DNS server in client configurations. Empty: the router\'s LAN address (its DNS, with DNS over HTTPS when on).'));
		o.datatype = 'ipaddr';
		o.placeholder = _('router');

		s = m.section(form.GridSection, 'wireguard_peer', _('Peers'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = false;
		s.nodescriptions = true;
		s.addbtntitle = _('Add peer');
		s.modaltitle = _('WireGuard peer');

		/* a new peer: key pair, preshared key, next free address */
		s.handleAdd = function(ev) {
			var sec = this;
			return nc.callWgKeys().then(function(k) {
				var sid = sec.map.data.add('nijika', 'wireguard_peer'), a = nextAddress();
				if (k && k.private_key) {
					uci.set('nijika', sid, 'private_key', k.private_key);
					uci.set('nijika', sid, 'public_key', k.public_key);
					uci.set('nijika', sid, 'preshared_key', k.preshared_key);
				}
				if (a)
					uci.set('nijika', sid, 'allowed_ips', [ a ]);
				uci.set('nijika', sid, 'client_allowed_ips', [ '0.0.0.0/0' ]);
				sec.map.addedSection = sid;
				return sec.renderMoreOptionsModal(sid);
			});
		};

		s.renderRowActions = function(sid) {
			var node = form.GridSection.prototype.renderRowActions.apply(this, arguments),
			    box = node.querySelector('.cbi-section-actions > div') || node.firstChild || node;
			if (uci.get('nijika', sid, 'private_key'))
				box.insertBefore(E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'title': _('Client configuration and QR code'),
					'click': ui.createHandlerFn(this, function() { return showClient(sid); })
				}, _('QR')), box.firstChild);
			return node;
		};

		o = s.option(form.Flag, 'enabled', _('On'));
		o.default = '1';
		o.rmempty = false;
		o.editable = true;

		o = s.option(form.Value, 'description', _('Name'));
		o.datatype = 'maxlength(40)';
		o.placeholder = _('phone, laptop, office...');

		o = s.option(form.DynamicList, 'allowed_ips', _('Allowed IPs'),
			_('The peer\'s tunnel address (<code>/32</code>), plus the networks behind it for a site-to-site link (routed to wg0).'));
		o.datatype = 'cidr';
		o.textvalue = function(sid) { return list(this.cfgvalue(sid)).join(', ') || '-'; };

		o = s.option(form.DummyValue, '_state', _('Status'));
		o.modalonly = false;
		o.textvalue = function(sid) {
			return E('span', { 'data-wg-state': sid }, peerState(self.st, sid));
		};

		o = s.option(form.Value, 'public_key', _('Public key'),
			_('Filled in for a key pair made here. A device with its own keys (e.g. an existing MikroTik WireGuard): paste its public key here and give it this router\'s public key (Status above); clear the private key below, and the preshared key unless the same one is set there.'));
		o.modalonly = true;
		o.rmempty = false;
		keyOption(o, true);

		o = s.option(form.Value, 'private_key', _('Private key (kept for the QR code)'),
			_('The peer\'s own private key, kept only to show its configuration and QR code here. Clear it once the device is set up, or when the device made its own keys.'));
		o.modalonly = true;
		o.password = true;
		keyOption(o, false);

		o = s.option(form.Value, 'preshared_key', _('Preshared key'), _('Optional extra symmetric key, the same on both sides.'));
		o.modalonly = true;
		o.password = true;
		keyOption(o, false);

		o = s.option(form.DynamicList, 'client_allowed_ips', _('Through the tunnel (client)'),
			_('AllowedIPs of the client configuration: <code>0.0.0.0/0</code> sends all the device\'s IPv4 traffic through the router; or only the LAN and the tunnel subnet, e.g. <code>192.168.0.0/24</code>.'));
		o.modalonly = true;
		o.datatype = 'cidr';
		o.placeholder = '0.0.0.0/0';

		o = s.option(form.Value, 'endpoint_host', _('Endpoint'),
			_('Site-to-site: the other side\'s host name or address, so this router connects to it. Empty for phones and laptops: they connect here.'));
		o.modalonly = true;
		o.datatype = 'host';

		o = s.option(form.Value, 'endpoint_port', _('Endpoint port'));
		o.modalonly = true;
		o.datatype = 'port';
		o.placeholder = '51820';
		o.depends({ endpoint_host: '', '!reverse': true });

		o = s.option(form.Value, 'persistent_keepalive', _('Keepalive (s)'),
			_('Site-to-site behind NAT: 25 keeps the path open. 0 or empty: off.'));
		o.modalonly = true;
		o.datatype = 'range(0,65535)';
		o.placeholder = '0';

		o = s.option(form.Flag, 'route_allowed_ips', _('Route allowed IPs'),
			_('Routes the networks among the allowed IPs to wg0 (never a default route: the router\'s own internet stays on the WAN).'));
		o.modalonly = true;
		o.default = '1';

		this.box = nc.mapStatusBox(m, E('div', {}, statusBox(self.st)));

		return m.render().then(function(node) {
			poll.add(L.bind(self.refresh, self), 5);
			return node;
		});
	},

	refresh: function() {
		var self = this;
		return L.resolveDefault(nc.callWgStatus(), null).then(function(st) {
			if (!st || !self.box)
				return;
			self.st = st;
			L.dom.content(self.box, statusBox(st));
			document.querySelectorAll('[data-wg-state]').forEach(function(n) {
				L.dom.content(n, peerState(st, n.getAttribute('data-wg-state')));
			});
		});
	}
});
