'use strict';
'require view';
'require form';
'require nijika.common as nc';

/*
 * GPON Settings, as the stock GUI's Setup > GPON Settings (formgponConf):
 * LOID, PLOAM password, device type, OMCI OLT mode. Saved like the stock
 * page applies them: the LOID goes to OMCI, a new PLOAM password
 * re-registers with the OLT, a LOID / device type / OLT mode change
 * restarts OMCI (restartOMCIsettings). The serial number is shown as on the
 * stock page; it changes with Quick Setup or `nijika sn` (reboot).
 */

var KEYS = [ 'LOID', 'LOID_PASSWD', 'GPON_PLOAM_PASSWD', 'DEVICE_TYPE', 'OMCI_OLT_MODE' ];

/* stock gpon.asp: no spaces in the passwords */
function noSpace(section_id, value) {
	return /\s/.test(value) ? _('Spaces are not allowed') : true;
}

return view.extend({
	load: function() {
		return nc.callMibGet(KEYS.concat([ 'GPON_SN' ]));
	},

	render: function(v) {
		var m, s, o;

		this.orig = v || {};
		m = new form.JSONMap({ gpon: Object.assign({}, this.orig) }, _('GPON Settings'),
			_('How this ONT authenticates to the OLT. Changes apply right away, as on the stock GUI: the ONT re-registers with the OLT, which interrupts the PON connection for a moment.'));
		this.map = m;

		s = m.section(form.NamedSection, 'gpon', 'gpon');

		o = s.option(form.DummyValue, 'GPON_SN', _('Serial number'),
			_('Changed with Quick Setup or <code>nijika sn</code>; takes effect after a reboot.'));

		o = s.option(form.Value, 'LOID', _('LOID'), _('Logical ONU ID, if the ISP uses LOID authentication; empty = none.'));
		o.datatype = 'maxlength(20)';
		o = s.option(form.Value, 'LOID_PASSWD', _('LOID password'));
		o.password = true;
		o.datatype = 'maxlength(12)';
		o.validate = noSpace;

		o = s.option(form.Value, 'GPON_PLOAM_PASSWD', _('PLOAM password'),
			_('Registration ID / PLOAM password, up to 10 characters (GPON).'));
		o.password = true;
		o.datatype = 'maxlength(10)';
		o.validate = noSpace;

		o = s.option(form.ListValue, 'DEVICE_TYPE', _('Device type'),
			_('How the OMCI stack presents the ONT: bridge (SFU), router (HGU) or both.'));
		o.value('0', _('Bridge'));
		o.value('1', _('Router'));
		o.value('2', _('Hybrid'));

		o = s.option(form.ListValue, 'OMCI_OLT_MODE', _('OMCI OLT mode'),
			_('OMCI compatibility with the OLT vendor. More identity settings: PON > ONT Identity.'));
		o.value('0', _('Default'));
		o.value('1', 'Huawei');
		o.value('2', 'ZTE');
		o.value('3', _('Customized'));
		if (this.orig.OMCI_OLT_MODE != null && !/^[0-3]$/.test(this.orig.OMCI_OLT_MODE))
			o.value(this.orig.OMCI_OLT_MODE, _('Other (%s)').format(this.orig.OMCI_OLT_MODE));

		s.children.forEach(function(c) { c.retain = true; });

		return m.render();
	},

	handleSave: function() {
		return nc.mibSave(this.map, 'gpon', this.orig, KEYS, _('GPON settings saved.'));
	},

	handleSaveApply: function() {
		return this.handleSave();
	},

	handleReset: null
});
