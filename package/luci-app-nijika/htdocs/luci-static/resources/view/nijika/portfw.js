'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require nijika.common as nc';

/*
 * Network > Port Forwarding: the stock GUI's Firewall > Port Forwarding
 * (formPortFw): the switch PORT_FW_ENABLE and the rules of PORT_FW_TBL.
 * Saving replaces the static rules (rpcd portfw_set: flash del/add/set) and
 * applies them like the stock page (reWriteAllDhcpcScript, setupPortFW).
 * Rules a LAN device opened through UPnP (Dynamic) are shown, not edited.
 * The table size is the stock configuration's (flash all, chain info).
 *
 * Record fields (flash names): IP, PortStart/PortEnd (internal ports),
 * externalportStart/End (0 = the internal ones), Protocol (1 TCP, 2 UDP,
 * 3 both: D-Link's encoding), remotehost (0.0.0.0 = any source), OutInf
 * (WAN ifIndex, 65535 = any), Comment, enable.
 */

var ANY_WAN = '65535';

function ports(a, b) {
	if (!+a)
		return '';
	return (+b && +b != +a) ? '%d-%d'.format(+a, +b) : String(+a);
}

function range(v) {
	var m = String(v || '').trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
	return m ? [ +m[1], m[2] ? +m[2] : +m[1] ] : null;
}

/* list cell of a ListValue: its label, not the stored value */
function choiceText(sid) {
	var v = String(this.cfgvalue(sid)), i = this.keylist.indexOf(v);
	return i >= 0 ? this.vallist[i] : v;
}

function validRange(sid, v) {
	if (v == null || v === '')
		return true;
	var r = range(v);
	return (r && r[0] >= 1 && r[1] <= 65535 && r[1] >= r[0]) ? true : _('A port (1-65535) or a range like 8000-8100');
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(nc.callPortfwGet(), {}),
			uci.load('rtk')
		]);
	},

	render: function(data) {
		var pf = data[0] || {}, recs = (pf.chain && pf.chain.records) || [], self = this, m, s, o;

		this.max = +pf.max || 0;
		this.dynamic = recs.filter(function(r) { return r.Dynamic == '1'; });

		var json = {
			global: { enable: pf.enable ? '1' : '0' },
			rule: recs.filter(function(r) { return r.Dynamic != '1'; }).map(function(r) {
				return {
					enable: r.enable == '0' ? '0' : '1',
					comment: r.Comment || '',
					proto: r.Protocol == '1' || r.Protocol == '2' ? r.Protocol : '3',
					ext: ports(r.externalportStart, r.externalportEnd),
					ip: r.IP || '',
					int: ports(r.PortStart, r.PortEnd),
					rhost: r.remotehost && r.remotehost != '0.0.0.0' ? r.remotehost : '',
					wan: r.OutInf || ANY_WAN
				};
			})
		};

		m = new form.JSONMap(json, _('Port Forwarding'),
			_('Opens ports on the WAN address to a device on the LAN, as on the stock GUI\'s Port Forwarding page. Saving applies the rules right away.'));
		this.map = m;

		s = m.section(form.NamedSection, 'global', 'global');
		o = s.option(form.Flag, 'enable', _('Port forwarding'), _('Off: no rule is active (they are kept).'));
		o.rmempty = false;
		o = s.option(form.DummyValue, '_count', _('Rules'));
		o.cfgvalue = function() {
			var used = m.data.sections('json', 'rule').length + self.dynamic.length;
			return self.max ? _('%d of %d (the stock table\'s size, UPnP rules included)').format(used, self.max) : String(used);
		};

		s = m.section(form.GridSection, 'rule', _('Rules'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = false;
		s.nodescriptions = true;
		s.addbtntitle = _('Add rule');
		/* JSONMap names array rows by position and new rows by count, which
		 * collide ("rule1"): give a new rule a name of its own */
		s.handleAdd = function(ev) {
			return form.GridSection.prototype.handleAdd.call(this, ev, 'new%d'.format(Date.now()));
		};
		s.renderSectionAdd = function() {
			var node = form.GridSection.prototype.renderSectionAdd.apply(this, arguments);
			var used = m.data.sections('json', 'rule').length + self.dynamic.length;
			if (self.max && used >= self.max)
				node.querySelectorAll('button, input').forEach(function(b) { b.disabled = true; });
			return node;
		};

		o = s.option(form.Flag, 'enable', _('On'));
		o.default = '1';
		o.rmempty = false;
		o = s.option(form.Value, 'comment', _('Name'));
		o.datatype = 'maxlength(59)';
		o = s.option(form.ListValue, 'proto', _('Protocol'));
		o.value('3', 'TCP + UDP');
		o.value('1', 'TCP');
		o.value('2', 'UDP');
		o.default = '3';
		o.textvalue = choiceText;
		o = s.option(form.Value, 'ext', _('External port'), _('Empty: the same as the internal port(s).'));
		o.placeholder = _('same');
		o.validate = validRange;
		o.textvalue = function(sid) { return this.cfgvalue(sid) || _('same'); };
		o = s.option(form.Value, 'ip', _('Internal address'));
		o.datatype = 'ip4addr("nomask")';
		o.rmempty = false;
		o = s.option(form.Value, 'int', _('Internal port'));
		o.rmempty = false;
		o.validate = function(sid, v) { return v ? validRange(sid, v) : _('Required'); };
		o = s.option(form.ListValue, 'wan', _('WAN'));
		o.value(ANY_WAN, _('Any'));
		uci.sections('rtk', 'ATM_VC_TBL').forEach(function(r, i) {
			if (r.ChannelMode != '0')
				o.value(String(r.ifIndex), nc.wanLabel(r, i));
		});
		o.default = ANY_WAN;
		o.textvalue = choiceText;
		o = s.option(form.Value, 'rhost', _('Source address'), _('Only from this address; empty: from anywhere.'));
		o.modalonly = true;
		o.datatype = 'ip4addr("nomask")';

		var dyn = this.dynamic.length ? E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Opened through UPnP')),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [ _('Name'), _('Protocol'), _('External port'), _('Internal address'), _('Internal port') ]
					.map(function(t) { return E('th', { 'class': 'th' }, t); }))
			].concat(this.dynamic.map(function(r) {
				return E('tr', { 'class': 'tr' }, [ r.Comment || '-', { 1: 'TCP', 2: 'UDP' }[r.Protocol] || 'TCP + UDP',
					ports(r.externalportStart, r.externalportEnd) || ports(r.PortStart, r.PortEnd), r.IP, ports(r.PortStart, r.PortEnd) ]
					.map(function(t) { return E('td', { 'class': 'td' }, t); }));
			})))
		]) : E([]);

		return m.render().then(function(node) { return E([], [ node, dyn ]); });
	},

	handleSave: function() {
		var self = this, m = this.map;
		return m.save().then(function() {
			var rules = m.data.sections('json', 'rule').map(function(r) {
				var e = range(r.ext), i = range(r.int) || [ 0, 0 ];
				return {
					enable: r.enable == '0' ? 0 : 1, comment: r.comment || '', proto: +r.proto || 3,
					ip: r.ip || '', from: i[0], to: i[1], efrom: e ? e[0] : 0, eto: e ? e[1] : 0,
					rhost: r.rhost || '0.0.0.0', ifindex: +r.wan || 65535
				};
			});
			if (self.max && rules.length + self.dynamic.length > self.max)
				throw new Error(_('the stock table holds %d rules').format(self.max));
			return nc.callPortfwSet(m.data.get('json', 'global', 'enable') == '1', rules).then(function(r) {
				if (!r || r.error)
					throw new Error((r && r.error) || '?');
				ui.addNotification(null, E('p', nc.applyText(r, _('Port forwarding saved.'))), 'info');
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
