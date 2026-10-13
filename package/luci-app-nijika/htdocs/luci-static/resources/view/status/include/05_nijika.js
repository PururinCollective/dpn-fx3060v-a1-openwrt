'use strict';
'require baseclass';
'require nijika.common as nc';

return baseclass.extend({
	title: _('PON / ONT'),

	load: function() {
		return L.resolveDefault(nc.callStatus(), {});
	},

	render: function(st) {
		if (!st || st.error)
			return E('em', {}, (st && st.error) || _('PON status not available yet'));

		return E([], [
			nc.style(),
			nc.kvTable([
				[ _('ONU state'), nc.stateBadge(st.state, st.los) ],
				[ _('RX power'), nc.levelBar(st.rx_dbm, 'dBm', -32, -5, -27, -8) ],
				[ _('TX power'), nc.levelBar(st.tx_dbm, 'dBm', -2, 7, 0.5, 5) ],
				[ _('OLT vendor'), st.olt_vendor || '-' ],
				[ _('GPON serial number'), st.sn || '-' ],
				[ _('Details'), E('a', { 'href': L.url('admin/nijika/status') }, _('PON → ONT Status')) ]
			])
		]);
	}
});
