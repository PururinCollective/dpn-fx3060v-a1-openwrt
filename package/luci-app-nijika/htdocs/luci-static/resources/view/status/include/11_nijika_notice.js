// SPDX-License-Identifier: Apache-2.0

'use strict';
'require baseclass';

/*
 * Status > Overview, after System: the attribution notice of a build not
 * from the original repository (AGENTS.md section 6). scripts/assemble.sh
 * writes the notice over the placeholder; in a build of the original
 * repository it is empty and the section stays hidden.
 */

var NOTICE = '@NIJIKA_NOTICE@';

return baseclass.extend({
	title: _('Firmware'),

	load: function() {
		return Promise.resolve();
	},

	render: function() {
		return (NOTICE && NOTICE.charAt(0) != '@') ? E('p', {}, NOTICE) : null;
	}
});
