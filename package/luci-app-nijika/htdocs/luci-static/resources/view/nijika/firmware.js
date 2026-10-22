// SPDX-License-Identifier: Apache-2.0

'use strict';
'require view';
'require dom';
'require ui';
'require nijika.common as nc';

/*
 * Firmware banks (A/B). The device keeps two complete firmwares
 * (ubi_{DTB,k,r}{0,1}); U-Boot boots sw_commit, or sw_tryactive once with a
 * 60 s watchdog. Same logic as `nijika boot` / `nijika upgrade`.
 */

return view.extend({
	load: function() {
		return nc.callBootGet();
	},

	renderBanks: function(b) {
		var self = this;
		var pending = (b.tryactive != null && b.tryactive !== '' && b.tryactive != '2');
		return E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th left' }, _('Bank')), E('th', { 'class': 'th left' }, _('Firmware')),
				E('th', { 'class': 'th left' }, _('State')), E('th', { 'class': 'th right' }, _('Actions'))
			])
		].concat((b.banks || []).map(function(bank) {
			var running = (bank.bank == b.running),
			    committed = (String(bank.bank) == String(b.commit)),
			    trial = pending && String(bank.bank) == String(b.tryactive);
			var tags = [];
			if (running) tags.push(E('span', { 'class': 'nijika-badge ok' }, _('running')));
			if (committed) tags.push(E('span', { 'class': 'nijika-badge warn' }, _('boot default')));
			if (trial) tags.push(E('span', { 'class': 'nijika-badge bad' }, _('trial on next boot')));
			if (bank.valid == '0') tags.push(E('span', { 'class': 'nijika-badge bad' }, _('invalid')));
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left' }, String(bank.bank)),
				E('td', { 'class': 'td left nijika-mono' }, bank.version || '-'),
				E('td', { 'class': 'td left' }, tags.reduce(function(a, t) { return a.concat([ t, ' ' ]); }, [])),
				E('td', { 'class': 'td right' }, running ? '' : [
					E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'setBank', bank.bank, 'try') }, _('Try once')), ' ',
					E('button', { 'class': 'btn cbi-button-action', 'click': ui.createHandlerFn(self, 'setBank', bank.bank, 'commit') }, _('Make default'))
				])
			]);
		})));
	},

	setBank: function(bank, mode) {
		return nc.callBootSet(bank, mode).then(L.bind(function(r) {
			if (!r || r.error)
				throw new Error((r && r.error) || 'boot_set failed');
			return nc.callBootGet().then(L.bind(function(b) {
				dom.content(this.banksNode, this.renderBanks(b));
				nc.rebootPrompt(nc, r.message);
			}, this));
		}, this)).catch(function(e) {
			ui.addNotification(null, E('p', e.message || e), 'danger');
		});
	},

	handleUpload: function(ev) {
		var self = this;
		return ui.uploadFile('/tmp/nijika-fw.bin', ev.target.firstChild || ev.target).then(function() {
			return nc.callFwCheck();
		}).then(function(res) {
			if (!res || !res.valid) {
				ui.addNotification(null, E('p', _('Invalid firmware: %s').format((res && (res.message || res.error)) || '?')), 'danger');
				return;
			}
			var mode = E('select', { 'class': 'cbi-input-select' }, [
				E('option', { 'value': 'try' }, _('Try once, keep the current firmware as fallback (recommended)')),
				E('option', { 'value': 'commit' }, _('Make it the boot default')),
				E('option', { 'value': 'none' }, _('Only write it, do not change boot selection'))
			]);
			var replace = E('input', { 'type': 'checkbox', 'id': 'nijika-replace-stock' });
			ui.showModal(_('Flash firmware'), [
				nc.kvTable([
					[ _('Image type'), res.format == 'sysupgrade' ? _('NijikaWrt sysupgrade') : _('Factory / stock D-Link') ],
					[ _('Version'), E('span', { 'class': 'nijika-mono' }, res.version || '-') ],
					[ _('Size'), '%1024mB'.format(res.size) ],
					[ _('Target bank'), '%d (%s)'.format(res.target, res.target_version || _('empty')) ]
				]),
				E('p', {}, _('The image is written to the other bank; the running firmware is not touched. OpenWrt settings on the overlay are kept.')),
				res.target_stock ? E('div', { 'class': 'alert-message warning' }, [
					E('p', {}, _('Bank %d holds the stock D-Link firmware (%s), the fallback. Flashing replaces it. To keep stock and NijikaWrt side by side, boot the stock bank and upload the -factory.bin image there instead.').format(res.target, res.target_version)),
					E('label', {}, [ replace, ' ', _('Replace the stock firmware in bank %d').format(res.target) ])
				]) : '',
				mode,
				E('div', { 'class': 'right', 'style': 'margin-top:1em' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
					E('button', { 'class': 'btn cbi-button-positive important', 'click': function() {
						if (res.target_stock && !replace.checked) {
							ui.addNotification(null, E('p', _('Tick "Replace the stock firmware" to overwrite the stock bank.')), 'warning');
							return;
						}
						self.flash(mode.value, res.target_stock && replace.checked);
					} }, _('Flash'))
				])
			]);
		}).catch(function(e) {
			ui.addNotification(null, E('p', _('Upload failed: %s').format(e.message || e)), 'danger');
		});
	},

	flash: function(mode, replaceStock) {
		var log = E('div', { 'class': 'nijika-pre' }, _('Starting…'));
		ui.showModal(_('Flashing…'), [ E('p', { 'class': 'spinning' }, _('Writing UBI volumes, do not power off.')), log ]);
		var self = this;
		return nc.callFwFlash(mode, replaceStock ? true : false).then(function(r) {
			if (r && r.error) {
				ui.showModal(_('Flashing refused'), [ E('div', { 'class': 'nijika-pre' }, r.error),
					E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))) ]);
				return;
			}
			var poll = function() {
				return nc.callFwStatus().then(function(st) {
					dom.content(log, st.log || '');
					if (st.running)
						return new Promise(function(r) { window.setTimeout(r, 1500); }).then(poll);
					if (st.rc == 0) {
						ui.hideModal();
						return nc.callBootGet().then(function(b) {
							dom.content(self.banksNode, self.renderBanks(b));
							if (mode == 'none')
								ui.addNotification(null, E('p', _('Firmware written.')), 'info');
							else
								nc.rebootPrompt(nc, _('Firmware written to the other bank. Reboot to start it.'));
						});
					}
					ui.showModal(_('Flashing failed'), [ E('div', { 'class': 'nijika-pre' }, st.log || ''),
						E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))) ]);
				});
			};
			return poll();
		});
	},

	render: function(b) {
		this.banksNode = E('div', {}, this.renderBanks(b || {}));
		return E([], [
			nc.style(),
			E('h2', {}, _('Firmware Upgrade')),
			E('div', { 'class': 'cbi-map-descr' },
				_('This page is used to manage the two firmware banks of the device. A NijikaWrt or stock D-Link image is written to the inactive bank and started once; the device starts the active bank again if the new image does not boot. CLI: <code>nijika boot</code>, <code>nijika upgrade</code>.')),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Banks')),
				E('p', {}, _('Running from bank %s.').format(b && b.running)),
				this.banksNode
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Flash to the other bank')),
				E('p', { 'class': 'nijika-hint' }, _('Accepts the NijikaWrt <code>-sysupgrade.bin</code> (checked by board metadata and CRC) as well as <code>-factory.bin</code> and stock D-Link firmware (checked by md5.txt). Flashing a stock image here is the way back to the D-Link firmware.')),
				E('button', { 'class': 'btn cbi-button-action important', 'click': ui.createHandlerFn(this, 'handleUpload') }, _('Upload image…'))
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
