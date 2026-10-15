/*
 * rtk-apply: the "apply" half of the stock boa web forms.
 *
 * A stock /boaform/<form> handler writes the configuration (mib_set,
 * mib_chain_update), then calls a libmib function that makes the running
 * stack follow it. NijikaWrt writes the configuration with the stock
 * `flash set` (which also commits it to flash); this tool makes the same
 * libmib calls the handlers make afterwards, so a change applies without a
 * reboot. Calls and their order follow the stock V1.1.2 boa and the Realtek
 * SDK sources (see docs/BOA.md).
 *
 * Runs inside the stock chroot: /usr/libexec/rtk/run /bin/rtk-apply <cmd>
 * Built with zig cc for aarch64-linux-gnu.2.30 (the stock glibc) and linked
 * against the stock libraries, like the stock wlan_apply.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* libmib (stock), prototypes from the SDK's utility.h / sysconfig.h /
 * subr_wlan.h. WAN records are passed through as opaque buffers. */
extern int mib_chain_info_name(char *name, void *info);
extern int mib_chain_total(int id);
extern int mib_chain_get(int id, unsigned int recordNum, void *ptr);
extern int deleteConnection(int configAll, void *pEntry);
extern void restartWAN(int configAll, void *pEntry);
extern void reSync_reStartVoIP(void);
extern int restart_IPFilter_DMZ_MACFilter(void);
extern int restart_lanip(void);
extern int restart_dhcp(void);
extern int config_WLAN(int action_type, int ssid_index);
/* librtk (stock), as called by boa's formgponConf / restartOMCIsettings */
extern int rt_gpon_deactivate(void);
extern int rt_gpon_activate(int initState);

#define CONFIGONE	0
#define CONFIGALL	1
#define ACT_RESTART	3
#define CONFIG_SSID_ALL	8

/* mib_chain_record_table_entry_T: int id at 0, per_record_size at 40 */
#define INFO_ID		0
#define INFO_RECSIZE	40

static int usage(void)
{
	fputs("usage: rtk-apply <command>\n"
	      "  firewall      IPv4/IPv6 filter rules, SPI default action, DMZ, MAC filter\n"
	      "  lan           LAN address and DHCP server\n"
	      "  wan-down <n>  before ATM_VC_TBL record <n> changes: take its connection down\n"
	      "  wan-up <n>    after the change: bring record <n> up again, resync VoIP\n"
	      "  wan           every WAN connection down and up again, resync VoIP\n"
	      "  wlan          restart WiFi (every radio and SSID)\n"
	      "  voip          reload the VoIP configuration and restart the VoIP stack\n"
	      "  gpon-omci     re-register with the OLT, OMCI MIB reset (LOID, OLT mode)\n"
	      "  gpon-ploam <password>  set the PLOAM password and re-register\n", stderr);
	return 2;
}

/* formatPloamPasswordToHex (SDK subr_pon.c): bytes as hex, "00" padded to
 * <length> bytes (10 for GPON) */
static int ploam_hex(const char *pw, char *out, size_t len)
{
	size_t i, n = strlen(pw);

	if (n > len)
		return 0;
	for (i = 0; i < len; i++)
		sprintf(out + 2 * i, "%02x", i < n ? (unsigned char)pw[i] : 0);
	return 1;
}

/* ATM_VC_TBL record <arg> into a malloc'd buffer */
static void *wan_record(const char *arg)
{
	unsigned char info[256];
	int id, size, total;
	char *end;
	long n;
	void *rec;

	memset(info, 0, sizeof(info));
	if (!mib_chain_info_name("ATM_VC_TBL", info)) {
		fputs("rtk-apply: ATM_VC_TBL unknown to libmib\n", stderr);
		return NULL;
	}
	memcpy(&id, info + INFO_ID, sizeof(id));
	memcpy(&size, info + INFO_RECSIZE, sizeof(size));
	n = strtol(arg, &end, 10);
	total = mib_chain_total(id);
	if (*arg == '\0' || *end != '\0' || n < 0 || n >= total) {
		fprintf(stderr, "rtk-apply: no WAN record %s (%d records)\n", arg, total);
		return NULL;
	}
	if (size <= 0 || size > 65536)
		size = 65536;
	rec = calloc(1, size);
	if (rec && !mib_chain_get(id, (unsigned int)n, rec)) {
		fprintf(stderr, "rtk-apply: reading WAN record %ld failed\n", n);
		free(rec);
		rec = NULL;
	}
	return rec;
}

int main(int argc, char **argv)
{
	const char *cmd = argc > 1 ? argv[1] : "";
	void *rec;

	if (!strcmp(cmd, "firewall")) {
		/* formFilter, formFilterV6, formDMZ */
		restart_IPFilter_DMZ_MACFilter();
	} else if (!strcmp(cmd, "lan")) {
		/* formTcpipLanSetup (LAN IP change), formDhcpd */
		restart_lanip();
		restart_dhcp();
	} else if (!strcmp(cmd, "wan-down") && argc == 3) {
		/* formEth (edit): deleteConnection(CONFIGONE, &old) */
		if (!(rec = wan_record(argv[2])))
			return 1;
		deleteConnection(CONFIGONE, rec);
		free(rec);
	} else if (!strcmp(cmd, "wan-up") && argc == 3) {
		/* formEth (edit): restartWAN(CONFIGONE, &new), reSync_reStartVoIP() */
		if (!(rec = wan_record(argv[2])))
			return 1;
		restartWAN(CONFIGONE, rec);
		free(rec);
		reSync_reStartVoIP();
	} else if (!strcmp(cmd, "wan")) {
		/* formIPv6EnableDisable: all connections */
		deleteConnection(CONFIGALL, NULL);
		restartWAN(CONFIGALL, NULL);
		reSync_reStartVoIP();
	} else if (!strcmp(cmd, "wlan")) {
		/* formWlanSetup, formWlEncrypt; same as `wlan_apply restart` */
		config_WLAN(ACT_RESTART, CONFIG_SSID_ALL);
	} else if (!strcmp(cmd, "voip")) {
		/* web_restart_solar: voip_flash_server_update + solar restart */
		reSync_reStartVoIP();
	} else if (!strcmp(cmd, "gpon-omci")) {
		/* restartOMCIsettings */
		rt_gpon_deactivate();
		system("omcicli mib reset");
		rt_gpon_activate(0);
	} else if (!strcmp(cmd, "gpon-ploam") && argc == 3) {
		/* formgponConf, PLOAM password */
		char hex[2 * 36 + 1], line[160];

		if (!ploam_hex(argv[2], hex, 10)) {
			fputs("rtk-apply: PLOAM password longer than 10 characters\n", stderr);
			return 1;
		}
		rt_gpon_deactivate();
		snprintf(line, sizeof(line), "/sbin/diag rt_gpon set registrationId-hex %s", hex);
		system(line);
		rt_gpon_activate(0);
	} else {
		return usage();
	}
	return 0;
}
