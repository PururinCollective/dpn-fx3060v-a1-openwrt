'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require poll';
'require nijika.common as nc';

/*
 * Services > DDNS: dynamic DNS by /usr/libexec/nijika/ddns (nijika.ddns and
 * the ddns_host sections), in place of the stock DDNS client, which does not
 * run under NijikaWrt. IPv4 (A records) only: the WAN's own address when it
 * is public, otherwise (carrier-grade NAT, a private or reserved range) the
 * address the internet sees, from a lookup service, with a warning.
 * Providers: the stock list (DtDNS closed in 2018) plus freedns.afraid.org
 * by update URL and Cloudflare.
 */

var PROVIDERS = [
	[ 'dyndns', 'DynDNS.org' ],
	[ 'noip', 'No-IP' ],
	[ 'changeip', 'ChangeIP' ],
	[ 'gnudip', 'GnuDIP' ],
	[ 'dynu', 'Dynu DNS' ],
	[ 'freedns', _('FreeDNS (user name and password)') ],
	[ 'afraid', _('freedns.afraid.org (update URL)') ],
	[ 'cloudflare', 'Cloudflare' ]
];
var USERPASS = [ 'dyndns', 'noip', 'changeip', 'gnudip', 'dynu', 'freedns' ];
var STOCK_NAMES = {
	dyndns: 'DynDNS.org', noip: 'No-IP', changeip: 'ChangeIP', gnudip: 'GnuDIP',
	dynu: 'Dynu DNS', dtdns: 'DtDNS', freedns: 'FreeDNS'
};
var HOST_RE = /^(@|(\*\.)?([A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+)$/;

function choiceText(sid) {
	var v = String(this.cfgvalue(sid) || ''), i = this.keylist.indexOf(v);
	return i >= 0 ? this.vallist[i] : v;
}

function dependsOn(o, list) {
	list.forEach(function(p) { o.depends('provider', p); });
}

function hostList(v) {
	return String(v || '').split(/[\s,;]+/).filter(function(h) { return h != ''; });
}

/* "5 min ago", by the router's clock */
function ago(st, t) {
	var d = (+st.now || 0) - (+t || 0);
	if (!t || d < 0)
		return '';
	if (d < 60)
		return _('just now');
	if (d < 3600)
		return _('%d min ago').format(Math.floor(d / 60));
	if (d < 86400)
		return _('%d h %d min ago').format(Math.floor(d / 3600), Math.floor(d % 3600 / 60));
	return _('%d days ago').format(Math.floor(d / 86400));
}

/* one entry's last result, from ddns_status hosts[sid] */
function hostState(st, sid) {
	var h = (st.hosts || {})[sid] || {}, en = uci.get('nijika', sid, 'enabled') != '0';

	if (!en)
		return E('em', {}, _('Disabled'));
	switch (h.result) {
	case 'good':
		return E('span', { 'style': 'color:#1f9d55' }, _('Updated to %s, %s').format(h.ip, ago(st, h.time)));
	case 'nochg':
		return E('span', { 'style': 'color:#1f9d55' }, _('Up to date (%s), checked %s').format(h.ip, ago(st, h.time)));
	case 'error':
		return E('span', { 'style': 'color:#b7791f', 'title': h.message },
			_('Error: %s - trying again at %s').format(h.message,
				h.next ? new Date(+h.next * 1000).toLocaleTimeString() : '?'));
	case 'failed':
		return E('span', { 'style': 'color:#cc1f1a', 'title': h.message },
			_('Failed: %s - check the settings, or press Update now').format(h.message));
	}
	if (!st.running)
		return E('em', {}, _('Not running'));
	if (!st.ip)
		return E('em', {}, _('Waiting for a public address'));
	return E('em', {}, _('Pending (saved changes are sent on the next check)'));
}

function sourceText(st) {
	if (st.source == 'wan')
		return _('the WAN\'s own address');
	if (st.source)
		return _('from %s').format(st.source.replace(/^https?:\/\//, '').replace(/\/$/, ''));
	return '';
}

/* the address check and, when the router is behind someone else's NAT,
 * why the DDNS names do not reach it */
function addressBox(st, view) {
	var rows = [], warn = null;

	var wan = st.wan ? (st.wan_ip ? '%s (%s)'.format(st.wan, st.wan_ip) : _('%s (no IPv4 address)').format(st.wan))
		: (st.kind ? _('No default route (WAN down?)') : '-');
	rows.push([ _('WAN'), wan ]);
	rows.push([ _('Published address'), st.ip ? '%s, %s'.format(st.ip, sourceText(st)) : '-' ]);
	rows.push([ _('Service'), st.running ? _('Running, checks every minute') :
		_('Not running (no enabled entry, or DDNS switched off below)') ]);

	if (st.kind == 'cgnat')
		warn = E('div', { 'class': 'alert-message warning' }, [
			E('strong', {}, _('Behind carrier-grade NAT (CGNAT).')), ' ',
			_('%s has %s, an address of the ISP\'s own network. The public address %s is shared with other customers of the ISP: connections from the internet to it, so to these DDNS names, port forwarding and DMZ, do not reach this router. DDNS still publishes it.')
				.format(st.wan, st.wan_ip, st.ip || '?'),
			E('br'),
			E('strong', {}, _('Use IPv6 for that:')), ' ',
			_('the LAN devices get public IPv6 addresses (no NAT); publish those as AAAA records, e.g. from the device itself, and allow them through the stock IPv6 firewall (NijikaWrt > Settings). Or ask the ISP for a public IPv4 address.')
		]);
	else if (st.kind == 'private' || st.kind == 'reserved')
		warn = E('div', { 'class': 'alert-message warning' }, [
			E('strong', {}, _('Not a public address.')), ' ',
			_('%s has %s: a router or the ISP\'s NAT (e.g. DS-Lite) is in front of this one, and %s is the address the internet sees. Connections from the internet reach this router only if that NAT forwards them. IPv6 avoids NAT altogether.')
				.format(st.wan, st.wan_ip, st.ip || '?')
		]);

	if (st.lookup_error == '1')
		warn = E([], [ warn, E('div', { 'class': 'alert-message danger' },
			_('The public address could not be looked up: none of the lookup services below answered. Nothing is sent until one does.')) ]);

	var stock = (st.stock || []).filter(function(e) { return e.hostname; });
	var note = stock.length ? E('div', { 'class': 'alert-message notice' }, [
		_('The stock firmware has DDNS entries: %s. Its DDNS client does not run under NijikaWrt (it would publish the WAN\'s own address over plain HTTP); add them here. The stock entries stay for the stock firmware bank.')
			.format(stock.map(function(e) {
				return '%s %s%s'.format(STOCK_NAMES[e.provider] || e.provider, e.hostname, e.enabled ? '' : _(' (off)'));
			}).join(', '))
	]) : null;

	return E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, _('Status')),
		E('table', { 'class': 'table' }, rows.map(function(r) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'width': '25%' }, r[0]),
				E('td', { 'class': 'td left' }, r[1])
			]);
		})),
		warn, note,
		E('div', { 'class': 'right' }, E('button', {
			'class': 'btn cbi-button-action',
			'click': ui.createHandlerFn(view, 'handleUpdateNow')
		}, _('Update now')))
	]);
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('nijika'),
			L.resolveDefault(nc.callDdnsStatus(), {}),
			L.resolveDefault(nc.wanStatus(), [])
		]);
	},

	render: function(data) {
		var self = this, wans = data[2] || [], m, s, o;

		this.st = data[1] || {};

		m = new form.Map('nijika', _('Dynamic DNS'),
			_('Keeps host names (A records, IPv4) on the router\'s public address, as the stock GUI\'s DDNS page, with freedns.afraid.org by update URL and Cloudflare added. Updates go over HTTPS, when the address changes and once a day.'));

		s = m.section(form.GridSection, 'ddns_host', _('Entries'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = false;
		s.nodescriptions = true;
		s.addbtntitle = _('Add entry');
		s.modaltitle = _('DDNS entry');

		o = s.option(form.Flag, 'enabled', _('On'));
		o.default = '1';
		o.rmempty = false;
		o.editable = true;

		o = s.option(form.ListValue, 'provider', _('Provider'));
		PROVIDERS.forEach(function(p) { o.value(p[0], p[1]); });
		o.default = 'cloudflare';
		o.textvalue = choiceText;

		o = s.option(form.Value, 'hostname', _('Host names'),
			_('One or more, comma separated. Cloudflare: full names or names within the zone, <code>@</code> for the zone itself; the A records must exist already (their proxy and TTL settings stay). freedns.afraid.org: optional, only shown here (the update URL names the host). GnuDIP: <em>user name</em>.<em>domain</em>.'));
		o.placeholder = 'example.org, www.example.org';
		o.validate = function(sid, v) {
			var p = this.section.formvalue(sid, 'provider'), bad;
			if (!hostList(v).length)
				return p == 'afraid' ? true : _('Required');
			bad = hostList(v).filter(function(h) { return !HOST_RE.test(h); });
			return bad.length ? _('Not a host name: %s').format(bad.join(', ')) : true;
		};
		o.textvalue = function(sid) {
			var v = hostList(this.cfgvalue(sid)).join(', ');
			return v || (uci.get('nijika', sid, 'provider') == 'afraid' ? E('em', {}, _('by update URL')) : '-');
		};

		o = s.option(form.DummyValue, '_state', _('Status'));
		o.modalonly = false;
		o.textvalue = function(sid) {
			return E('span', { 'data-ddns-state': sid }, hostState(self.st, sid));
		};

		/* Cloudflare */
		o = s.option(form.Value, 'zone', _('Zone'), _('The domain as Cloudflare lists it, e.g. <code>example.org</code>.'));
		o.modalonly = true;
		o.depends('provider', 'cloudflare');
		o.validate = function(sid, v) {
			return /^([A-Za-z0-9_-]+\.)+[A-Za-z0-9-]+$/.test(v || '') ? true : _('A domain, e.g. example.org');
		};
		o = s.option(form.Value, 'email', _('E-mail'),
			_('The account\'s e-mail, together with its <em>Global API Key</em> (as ddclient\'s login/password). Leave empty to use an <em>API token</em> instead.'));
		o.modalonly = true;
		o.depends('provider', 'cloudflare');
		o = s.option(form.Value, 'api_key', _('API key or token'),
			_('Global API Key (with the e-mail), or an API token with <em>Zone &gt; DNS &gt; Edit</em> for this zone (e-mail empty).'));
		o.modalonly = true;
		o.password = true;
		o.depends('provider', 'cloudflare');
		o.validate = function(sid, v) { return v ? true : _('Required'); };

		/* freedns.afraid.org by update URL */
		o = s.option(form.Value, 'url', _('Update URL'),
			_('The <em>Direct URL</em> of freedns.afraid.org &gt; Dynamic DNS, like <code>https://freedns.afraid.org/dynamic/update.php?&lt;token&gt;</code>, or only the token; <code>https://sync.afraid.org/u/&lt;token&gt;/</code> (version 2) works too. The address is added when sending.'));
		o.modalonly = true;
		o.password = true;
		o.depends('provider', 'afraid');
		o.validate = function(sid, v) {
			v = String(v || '').trim();
			if (!v)
				return _('Required');
			if (/sync\.afraid\.org\/u\/[A-Za-z0-9]+/.test(v) || /update\.php\?[A-Za-z0-9+\/=%_.-]+/.test(v) ||
			    /^[A-Za-z0-9+\/=%_.-]+$/.test(v))
				return true;
			return _('Expected https://freedns.afraid.org/dynamic/update.php?<token> or the token');
		};

		/* the stock providers */
		o = s.option(form.Value, 'username', _('User name'));
		o.modalonly = true;
		dependsOn(o, USERPASS);
		o.validate = function(sid, v) { return v ? true : _('Required'); };
		o = s.option(form.Value, 'password', _('Password'));
		o.modalonly = true;
		o.password = true;
		dependsOn(o, USERPASS);
		o.validate = function(sid, v) { return v ? true : _('Required'); };
		o = s.option(form.Value, 'server', _('GnuDIP server'),
			_('Host name of the GnuDIP server (<code>http://&lt;server&gt;/gnudip/cgi-bin/gdipupdt.cgi</code>), or the full URL of its update script.'));
		o.modalonly = true;
		o.depends('provider', 'gnudip');
		o.validate = function(sid, v) { return v ? true : _('Required'); };

		s = m.section(form.NamedSection, 'ddns', 'ddns', _('Settings'));
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('Dynamic DNS'), _('Off: no entry is updated (they are kept).'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.ListValue, 'interface', _('WAN'),
			_('The WAN whose address is published. Automatic: the one with the default route (the internet connection; <code>ppp0</code> with PPPoE).'));
		o.value('auto', _('Automatic (default route)'));
		wans.forEach(function(w) {
			if (w.ChannelMode != '0' && w.ifname)
				o.value(w.ifname, '%s (%s)'.format(w.name, w.ifname));
		});
		o.default = 'auto';

		o = s.option(form.DynamicList, 'ip_url', _('Address lookup'),
			_('Used when the WAN\'s address is not public (carrier-grade NAT 100.64.0.0/10, a private or reserved range): services that answer with the address the internet sees, in plain text; the first that answers counts.'));
		o.placeholder = 'http://ip1.dynupdate.no-ip.com/';
		o.validate = function(sid, v) {
			return (!v || /^https?:\/\/[^\s\/]+(\/\S*)?$/.test(v)) ? true : _('Expected http(s)://host/path');
		};

		o = s.option(form.Value, 'check_interval', _('Lookup interval (s)'),
			_('How often the address the internet sees is asked again, when the WAN\'s own is not public (the WAN itself is checked every minute).'));
		o.datatype = 'range(60,86400)';
		o.placeholder = '600';

		o = s.option(form.Value, 'force_interval', _('Refresh interval (s)'),
			_('An unchanged address is sent again after this long (the stock firmware: once a day). Some providers block clients that send unchanged updates too often.'));
		o.datatype = 'range(3600,2592000)';
		o.placeholder = '86400';

		this.box = nc.mapStatusBox(m, E('div', {}, addressBox(self.st, self)));

		return m.render().then(function(node) {
			poll.add(L.bind(self.refresh, self), 5);
			return node;
		});
	},

	refresh: function() {
		var self = this;
		return L.resolveDefault(nc.callDdnsStatus(), null).then(function(st) {
			if (!st || !self.box)
				return;
			self.st = st;
			L.dom.content(self.box, addressBox(st, self));
			document.querySelectorAll('[data-ddns-state]').forEach(function(n) {
				L.dom.content(n, hostState(st, n.getAttribute('data-ddns-state')));
			});
		});
	},

	handleUpdateNow: function() {
		var self = this;
		return nc.callDdnsUpdate().then(function(r) {
			if (!r || r.error)
				throw new Error((r && r.error) || '?');
			ui.addNotification(null, E('p', r.running ? _('Updating every entry now.') :
				_('The DDNS service is not running (no enabled entry, or switched off): one update pass was started.')), 'info');
			window.setTimeout(L.bind(self.refresh, self), 3000);
		}).catch(function(e) {
			ui.addNotification(null, E('p', _('Update failed: %s').format(e.message || e)), 'danger');
		});
	}
});
