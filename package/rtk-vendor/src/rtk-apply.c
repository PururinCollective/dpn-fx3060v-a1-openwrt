/*
 * rtk-apply: the "apply" half of the stock boa web forms.
 *
 * A stock /boaform/<form> handler writes the configuration (mib_set,
 * mib_chain_update), then calls a libmib function that makes the running
 * stack follow it. NijikaWrt writes the configuration with the stock
 * `flash set` (committed through configd, like boa's Commit()); this tool makes the same
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
extern int mib_chain_delete(int id, unsigned int recordNum);
extern void resolveServiceDependency(unsigned int idx);
extern void clear_delegated_default_wanconn(void *pEntry);
extern int delDhcpcOption(unsigned int ifindex);
extern void rtk_layer2bridging_update_wan_interface_mib_table(int action, unsigned int old_ifIndex,
							      unsigned int new_ifIndex);
extern int rtk_tr181_update_wan_interface_entry_list(int action, void *pOld, void *pNew);
extern int mib_chain_update(int id, void *ptr, unsigned int recordNum);
extern int updatePortForwarding(unsigned int old_id, unsigned int new_id);
extern int updateRoutingTable(unsigned int old_id, unsigned int new_id);
extern void Commit(void);
extern void rtk_multicast_snooping(void);
extern int restart_ethernet(int instnum);
extern int setup_wlan_block(void);
extern int setupPortFW(void);
extern void reWriteAllDhcpcScript(void);
/* UPnP (SDK utility.h): CONFIGALL stops miniupnpd and starts it again when
 * UPNP is on, on the WAN UPNP_EXT_ITF names */
extern int restart_upnp(int configAll, int wan_enable, int wan_IfIndex, int disable_upnp);
/* Restore Default (SDK utility.h): the current settings (cs) to the
 * program defaults, in configd's RAM and in flash; hs stays */
extern int reset_cs_to_default(int flag);
/* IP QoS (SDK subr_qos_3.c): take_qos_effect() is stopIPQ() + setupIPQ() */
extern int stopIPQ(void);
extern void take_qos_effect(void);
/* EasyMesh (D-Link libmib, as called by boa's formMultiAP) */
extern int setupMultiAPController(char *role, char *role_prev, char *backhaul_link,
				  unsigned char *dhcp_mode);
extern void setupMultiAP_TMAuto(void);
extern void setupMultiAPDisabled(void);
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

/* MIB_CE_ATM_VC_T of the stock V1.1.2 libmib (0x3c4 bytes): ifIndex at 0
 * (media << 16 | PPP unit << 8 | VC), cmode at 0x15 (boa formEth,
 * check_itfGroup) */
#define VC_RECSIZE	0x3c4
#define VC_CMODE	0x15
#define CHANNEL_MODE_PPPOE	2
#define CHANNEL_MODE_PPPOA	3
#define PPP_UNITS	8
#define NO_PPP		0xff

static int usage(void)
{
	fputs("usage: rtk-apply <command>\n"
	      "  firewall      IPv4/IPv6 filter rules, SPI default action, DMZ, MAC filter\n"
	      "  portfw        port forwarding (PORT_FW_ENABLE, PORT_FW_TBL)\n"
	      "  qos-stop      before the QoS configuration changes: tear the running QoS down\n"
	      "  qos           after the change: QoS policies, classification, traffic shaping\n"
	      "  lan           LAN address and DHCP server\n"
	      "  upnp          UPnP daemon (UPNP, UPNP_EXT_ITF)\n"
	      "  wan-down <n>  before ATM_VC_TBL record <n> changes: take its connection down\n"
	      "  wan-up <n>    after the change: bring record <n> up again, resync VoIP\n"
	      "  wan-mode <n>  after the connection mode of record <n> changed (before\n"
	      "                wan-up): drop what depended on it, new PPP unit\n"
	      "  wan           every WAN connection down and up again, resync VoIP\n"
	      "  wan-delete <n> [dhcpc]  delete ATM_VC_TBL record <n> (dhcpc: it is an\n"
	      "                IPoE DHCP client), as the stock WAN page does\n"
	      "  wlan          restart WiFi (every radio and SSID)\n"
	      "  wlan-block    LAN <-> WiFi blocking (WLAN_BLOCK_ETH2WIR)\n"
	      "  easymesh <role> <previous role> <backhaul> [norestart]  EasyMesh role\n"
	      "                (controller, auto, disabled; backhaul 0 wlan0, 1 wlan1, 3 auto),\n"
	      "                then a WiFi restart unless norestart (before WiFi starts)\n"
	      "  easymesh-pair EasyMesh pairing (WPS push button of the controller)\n"
	      "  snooping      IGMP/MLD snooping (MP_MODE)\n"
	      "  lan-port <n>  LAN port n (0..3) on/off (SW_PORT_TBL.<n>.Enable)\n"
	      "  voip          reload the VoIP configuration and restart the VoIP stack\n"
	      "  gpon-omci     re-register with the OLT, OMCI MIB reset (LOID, OLT mode)\n"
	      "  gpon-ploam <password>  set the PLOAM password and re-register\n"
	      "  factory-reset the stock configuration (cs) to factory defaults; reboot after\n", stderr);
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

static int wan_id, wan_idx, wan_size;	/* set by wan_record() */

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
	wan_id = id;
	wan_idx = (int)n;
	wan_size = size;
	rec = calloc(1, size);
	if (rec && !mib_chain_get(id, (unsigned int)n, rec)) {
		fprintf(stderr, "rtk-apply: reading WAN record %ld failed\n", n);
		free(rec);
		rec = NULL;
	}
	return rec;
}

static int is_ppp(const unsigned char *rec)
{
	return rec[VC_CMODE] == CHANNEL_MODE_PPPOE || rec[VC_CMODE] == CHANNEL_MODE_PPPOA;
}

/* formEth (edit) when the connection mode changed, stock V1.1.2 boa
 * 0x46e3f8. The mode is already written (flash set), the interface index
 * is still the old one: resolveServiceDependency drops what named the old
 * interface (IGMP/MLD proxy, port forwards, routes, ...), then the record
 * gets a PPP unit for PPPoE or none (0xff) otherwise. Unlike the stock form
 * the connection keeps its VC slot, so its name (PON_<n>) and MAC address
 * stay. wan-up starts it with the new index. */
static int wan_mode(const char *arg)
{
	unsigned char *rec, *old, *other;
	unsigned int old_if, new_if, ppp, used = 0, i, total;

	if (!(rec = wan_record(arg)))
		return 1;
	if (wan_size != VC_RECSIZE) {
		fprintf(stderr, "rtk-apply: WAN record is %d bytes, not the known layout\n", wan_size);
		free(rec);
		return 1;
	}
	other = calloc(1, wan_size);
	old = malloc(wan_size);
	if (!other || !old) {
		free(rec), free(other), free(old);
		return 1;
	}
	memcpy(old, rec, wan_size);
	memcpy(&old_if, rec, sizeof(old_if));

	/* PPP units of the other PPP connections */
	total = (unsigned int)mib_chain_total(wan_id);
	for (i = 0; i < total; i++) {
		unsigned int ifi;

		if ((int)i == wan_idx || !mib_chain_get(wan_id, i, other) || !is_ppp(other))
			continue;
		memcpy(&ifi, other, sizeof(ifi));
		if (((ifi >> 8) & 0xff) < PPP_UNITS)
			used |= 1u << ((ifi >> 8) & 0xff);
	}
	free(other);

	ppp = NO_PPP;
	if (is_ppp(rec)) {
		ppp = (old_if >> 8) & 0xff;
		if (ppp >= PPP_UNITS || (used & (1u << ppp))) {
			for (ppp = 0; ppp < PPP_UNITS && (used & (1u << ppp)); ppp++)
				;
			if (ppp == PPP_UNITS) {
				fputs("rtk-apply: no free PPP unit\n", stderr);
				free(rec), free(old);
				return 1;
			}
		}
	}
	new_if = (old_if & 0xff00ffu) | (ppp << 8);

	resolveServiceDependency(wan_idx);
	if (new_if != old_if) {
		rtk_layer2bridging_update_wan_interface_mib_table(2, old_if, new_if);
		updatePortForwarding(old_if, new_if);
		updateRoutingTable(old_if, new_if);
		memcpy(rec, &new_if, sizeof(new_if));
		rtk_tr181_update_wan_interface_entry_list(2, old, rec);
		if (!mib_chain_update(wan_id, rec, (unsigned int)wan_idx)) {
			fprintf(stderr, "rtk-apply: updating WAN record %d failed\n", wan_idx);
			free(rec), free(old);
			return 1;
		}
	}
	free(rec), free(old);
	Commit();
	printf("ifIndex 0x%x -> 0x%x\n", old_if, new_if);
	return 0;
}

int main(int argc, char **argv)
{
	const char *cmd = argc > 1 ? argv[1] : "";
	void *rec;

	if (!strcmp(cmd, "firewall")) {
		/* formFilter, formFilterV6, formDMZ */
		restart_IPFilter_DMZ_MACFilter();
	} else if (!strcmp(cmd, "portfw")) {
		/* formPortFw (stock V1.1.2 boa 0x45d730), after its Commit */
		reWriteAllDhcpcScript();
		setupPortFW();
	} else if (!strcmp(cmd, "qos-stop")) {
		/* formUpstreamQosPolicy / formDownstreamQosPolicy (stock V1.1.2
		 * boa 0x443644 / 0x443dbc): stopIPQ() while the old policy is
		 * still configured, before QOS_POLICY changes */
		stopIPQ();
	} else if (!strcmp(cmd, "qos")) {
		/* the QoS forms (0x443644, 0x443dbc, formQosRule 0x4426d8,
		 * formQosTraffictl 0x441a3c), after their mib writes */
		take_qos_effect();
	} else if (!strcmp(cmd, "lan")) {
		/* formTcpipLanSetup (LAN IP change), formDhcpd */
		restart_lanip();
		restart_dhcp();
	} else if (!strcmp(cmd, "upnp")) {
		/* formUpnp, after its mib writes */
		restart_upnp(CONFIGALL, 0, 0, 0);
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
	} else if (!strcmp(cmd, "wan-mode") && argc == 3) {
		return wan_mode(argv[2]);
	} else if (!strcmp(cmd, "wan-delete") && (argc == 3 || argc == 4)) {
		/* formEth (delete), stock V1.1.2 boa 0x46e3f8 */
		unsigned int ifindex;

		if (!(rec = wan_record(argv[2])))
			return 1;
		memcpy(&ifindex, rec, sizeof(ifindex));	/* ifIndex: first member */
		rtk_layer2bridging_update_wan_interface_mib_table(0, ifindex, 0);
		if (argc == 4 && !strcmp(argv[3], "dhcpc"))
			delDhcpcOption(ifindex);
		rtk_tr181_update_wan_interface_entry_list(0, rec, NULL);
		clear_delegated_default_wanconn(rec);
		deleteConnection(CONFIGONE, rec);
		resolveServiceDependency(wan_idx);
		free(rec);
		if (mib_chain_delete(wan_id, wan_idx) != 1) {
			fprintf(stderr, "rtk-apply: deleting WAN record %d failed\n", wan_idx);
			return 1;
		}
		restartWAN(CONFIGONE, NULL);
		reSync_reStartVoIP();
		Commit();
	} else if (!strcmp(cmd, "wan")) {
		/* formIPv6EnableDisable: all connections */
		deleteConnection(CONFIGALL, NULL);
		restartWAN(CONFIGALL, NULL);
		reSync_reStartVoIP();
	} else if (!strcmp(cmd, "wlan")) {
		/* formWlanSetup, formWlEncrypt; same as `wlan_apply restart` */
		config_WLAN(ACT_RESTART, CONFIG_SSID_ALL);
	} else if (!strcmp(cmd, "easymesh") && (argc == 5 || (argc == 6 && !strcmp(argv[5], "norestart")))) {
		/* formMultiAP (stock V1.1.2 boa 0x44791c), Apply: role, then
		 * config_WLAN and the commit. The DHCP mode stays the server's:
		 * the agent role is not offered on the gateway. The role setups
		 * only write the configuration, so before the stock WiFi starts
		 * (norestart) the commit is enough. */
		unsigned char dhcp[4] = { 2, 0, 0, 0 };

		if (!strcmp(argv[2], "controller"))
			setupMultiAPController(argv[2], argv[3], argv[4], dhcp);
		else if (!strcmp(argv[2], "auto"))
			setupMultiAP_TMAuto();
		else if (!strcmp(argv[2], "disabled"))
			setupMultiAPDisabled();
		else
			return usage();
		if (argc == 5)
			config_WLAN(ACT_RESTART, CONFIG_SSID_ALL);
		Commit();
	} else if (!strcmp(cmd, "easymesh-pair")) {
		/* formMultiAP, Start PBC (hostapd WPS): the mesh daemons pick up
		 * the virtual push button */
		system("echo 2 > /tmp/virtual_push_button");
	} else if (!strcmp(cmd, "wlan-block")) {
		/* formTcpipLanSetup: BlockEth2Wir */
		setup_wlan_block();
	} else if (!strcmp(cmd, "snooping")) {
		/* formTcpipLanSetup: snoop (after mib_set(MIB_MPMODE)) */
		rtk_multicast_snooping();
	} else if (!strcmp(cmd, "lan-port") && argc == 3) {
		/* formTcpipLanSetup: lan<i> -> restart_ethernet(i + 1) */
		char *end;
		long n = strtol(argv[2], &end, 10);

		if (*argv[2] == '\0' || *end != '\0' || n < 0 || n > 7) {
			fprintf(stderr, "rtk-apply: no LAN port %s\n", argv[2]);
			return 1;
		}
		restart_ethernet((int)n + 1);
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
	} else if (!strcmp(cmd, "factory-reset")) {
		/* formReboot "Restore Default" before its reboot (it ignores
		 * the return value); the stock reset button handler
		 * (rtk_sys_pushbtn_reset_action) calls it too */
		reset_cs_to_default(1);
	} else {
		return usage();
	}
	return 0;
}
