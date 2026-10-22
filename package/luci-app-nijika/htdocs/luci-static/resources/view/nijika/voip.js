// SPDX-License-Identifier: Apache-2.0

'use strict';
'require view';
'require form';
'require ui';
'require nijika.common as nc';

/*
 * Services > VoIP: the SIP accounts of both phone lines, as the stock GUI's
 * VoIP > Port1 / Port2 pages: per line a primary and a backup proxy, each
 * with its own account. Read and written with the stock voipflashcmd
 * (enable, display_name, number, login_id, password, addr, port,
 * domain_name per line and proxy); saving restarts the VoIP stack like the
 * stock page (voip_flash_server_update + solar restart, see docs/BOA.md).
 * One tab (and form map) per phone port.
 */

var KEYS = [ 'enable', 'display_name', 'number', 'login_id', 'password', 'addr', 'port', 'domain_name' ];
var LINES = 2, PROXIES = 2;

function sid(line, proxy) {
	return 'l%dp%d'.format(line, proxy);
}

return view.extend({
	load: function() {
		return L.resolveDefault(nc.callVoipGet(), []);
	},

	render: function(lines) {
		var self = this, s, o;

		this.orig = {};
		this.maps = [];
		for (var line = 0; line < LINES; line++) {
			var data = {};
			for (var p = 0; p < PROXIES; p++) {
				var v = (((lines || [])[line] || {}).proxies || [])[p] || {};
				data[sid(line, p)] = Object.assign({}, v, { enable: /^1/.test(v.enable || '') ? '1' : '0' });
				this.orig[sid(line, p)] = Object.assign({}, data[sid(line, p)]);
			}

			var m = new form.JSONMap(data);
			for (var proxy = 0; proxy < PROXIES; proxy++) {
				s = m.section(form.NamedSection, sid(line, proxy), 'proxy',
					proxy ? _('Backup proxy') : _('Primary proxy'));

				o = s.option(form.Flag, 'enable', _('Enable'));
				o.rmempty = false;

				o = s.option(form.Value, 'addr', _('Proxy server'), _('Host name or IP address of the SIP registrar / proxy.'));
				o.datatype = 'host';
				o.depends('enable', '1');
				o = s.option(form.Value, 'port', _('Proxy port'));
				o.datatype = 'port';
				o.placeholder = '5060';
				o.depends('enable', '1');
				o = s.option(form.Value, 'domain_name', _('SIP domain'));
				o.depends('enable', '1');

				o = s.option(form.Value, 'number', _('Phone number'));
				o.depends('enable', '1');
				o = s.option(form.Value, 'login_id', _('Login ID'));
				o.depends('enable', '1');
				o = s.option(form.Value, 'password', _('Password'));
				o.password = true;
				o.depends('enable', '1');
				o = s.option(form.Value, 'display_name', _('Display name'));
				o.depends('enable', '1');

				s.children.forEach(function(c) { c.retain = true; });
			}
			this.maps.push(m);
		}

		return Promise.all(this.maps.map(function(m) { return m.render(); })).then(function(nodes) {
			var view = E([], [
				E('h2', {}, _('VoIP')),
				E('div', { 'class': 'cbi-map-descr' },
					_('This page is used to configure the SIP accounts of the two phone ports (FXS). Each line registers with its primary proxy; the backup proxy is used when the primary proxy does not answer. Saving restarts the VoIP stack: the calls in progress are dropped.')),
				E('div', {}, nodes.map(function(node, i) {
					return E('div', { 'data-tab': 'phone%d'.format(i + 1), 'data-tab-title': _('Phone %d').format(i + 1) }, [ node ]);
				}))
			]);
			/* the tab bar goes in front of the panes' container */
			ui.tabs.initTabGroup(view.lastElementChild.childNodes);
			return view;
		});
	},

	handleSave: function() {
		var self = this, shown = {};

		/* only fields that are shown count (see nc.mibSave) */
		this.maps.forEach(function(m) {
			m.children.forEach(function(s) {
				s.children.forEach(function(o) {
					if (o.isActive(s.section))
						shown[s.section + '.' + o.option] = true;
				});
			});
		});

		return Promise.all(this.maps.map(function(m) { return m.save(); })).then(function() {
			var values = [];
			for (var l = 0; l < LINES; l++)
				for (var p = 0; p < PROXIES; p++)
					KEYS.forEach(function(k) {
						var id = sid(l, p);
						if (!shown[id + '.' + k])
							return;
						var v = self.maps[l].data.get('json', id, k);
						v = (v == null) ? '' : String(v);
						if (v !== String(self.orig[id][k] == null ? '' : self.orig[id][k]))
							values.push([ k, v, l, p ]);
					});
			if (!values.length) {
				ui.addNotification(null, E('p', _('Nothing changed.')), 'info');
				return;
			}
			return nc.callVoipSet(values).then(function(r) {
				if (!r || r.error || (r.failed && r.failed.length))
					throw new Error((r && r.error) || _('rejected: %s').format((r.failed || []).join(', ')));
				values.forEach(function(v) { self.orig[sid(v[2], v[3])][v[0]] = v[1]; });
				ui.addNotification(null, E('p', nc.applyText(r, _('VoIP settings saved.'))), 'info');
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
