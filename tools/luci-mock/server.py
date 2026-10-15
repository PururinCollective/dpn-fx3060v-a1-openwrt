#!/usr/bin/env python3
"""
LuCI mock for developing luci-app-nijika without the router.

Serves the LuCI client framework from a built rootfs (build/stage/www) and
answers the ubus JSON-RPC calls of the "nijika" rpcd object with synthetic
sample data (no real device secrets).

    ./build.sh rootfs assemble          # once, produces build/stage/www
    python3 tools/luci-mock/server.py   # http://127.0.0.1:8080/

Views: /cgi-bin/luci/admin/nijika/<status|quicksetup|omci|identity|mib|firmware|settings>
"""

import http.server
import json
import os
import socketserver
import sys
import time

TOP = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
WWW = os.environ.get('LUCI_WWW', os.path.join(TOP, 'build', 'stage', 'www'))
PORT = int(os.environ.get('PORT', '8080'))
VIEWS = ['status', 'quicksetup', 'wan', 'lan', 'wlan', 'portfw', 'dmz', 'voip', 'gpon', 'provision', 'identity', 'mib', 'firmware', 'settings']
BOOT = time.time()


def me(cls, name, insts):
    return {'class': cls, 'name': name, 'instances': [
        {'attrs': [[k, v] for k, v in attrs], 'raw': '\n'.join('%s: %s' % (k, v) for k, v in attrs) + ('\n' + raw if raw else '')}
        for attrs, raw in insts]}


# Real `omcicli mib get 171` rule tables from a TM Unifi OLT (Nokia/ALCL).
RULE = '''INDEX %d
Filter Outer   : PRI %s,VID %s, TPID %s
Filter Inner   : PRI %s,VID %s, TPID %s, EthType 0x00
Treatment Outer   : PRI %s,VID %s, TPID %s, RemoveTags %s
Treatment Inner   : PRI %s,VID %s, TPID %s'''
DEFAULT_RULES = [('15', '4096', '0', '15', '0', '5', '15', '0', '0', '3', '15', '0', '2'),
                 ('14', '4096', '5', '14', '4096', '0', '15', '0', '0', '3', '15', '4096', '3'),
                 ('15', '4096', '0', '14', '4096', '5', '15', '0', '0', '3', '15', '4096', '2')]


def rules(vids):
    tagged = [('15', '4096', '0', '8', v, '5', '15', '0', '0', '1', '8', v, '2') for v in vids]
    return 'ReceivedFrameVlanTaggingOperTable\n' + '\n'.join(
        RULE % ((n,) + r) for n, r in enumerate(tagged + DEFAULT_RULES))

DATA = {
    'status': lambda: {
        'state': 'O5', 'state_text': 'operational', 'los': False,
        'rx_dbm': '-19.70', 'tx_dbm': '3.21', 'temp_c': '46.2', 'voltage_v': '3.28', 'bias_ma': '11.8',
        'alarms': [{'name': n, 'status': 'no'} for n in ['LOS', 'LOF', 'LOM', 'SF', 'SD', 'TX Too Long', 'TX Mismatch']],
        'olt_vendor': 'HWTC', 'olt_vendor_hex': '0x48575443', 'sn': 'DLKI12345678', 'vendor_id': 'DLNK',
        'updated': int(time.time()), 'uptime': int(time.time() - BOOT) + 4440,
    },
    'olt': lambda: {
        'state': 'O5',
        'me131': me(131, 'OltG', [([('EntityId', '0x0'), ('OltVendorId', '0x48575443'), ('EquipId', '0x4d413536303054000000000000000000000000'),
                                   ('Version', '0x56355231303043303000000000'), ('ToDInfo', '0x0')], '')]),
        'me256': me(256, 'Ontg', [([('EntityID', '0x0'), ('VID', '0x444c4e4b'), ('Version', '0x41310000000000000000000000000000'),
                                   ('SerialNum', 'DLKI12345678'), ('TraffMgtOpt', '0'), ('AdminState', '0'), ('OpState', '0'), ('OntState', '5')], '')]),
        'me84': me(84, 'VlanTagFilterData', [([('EntityID', '0x1'), ('FilterTbl', '0x01f4'), ('FwdOp', '0x10'), ('NumOfEntries', '1')], ''),
                                             ([('EntityID', '0x2'), ('FilterTbl', '0x0258'), ('FwdOp', '0x10'), ('NumOfEntries', '1')], '')]),
        'me171': me(171, 'ExtVlanTagOperCfgData', [
            ([('EntityId', '0x101'), ('AssociationType', '2'), ('AssociatedMePoint', '0x101'),
              ('InputTPID', '0x8100'), ('OutputTPID', '0x8100'), ('DsMode', '0')], rules(['209', '500'])),
            ([('EntityId', '0x102'), ('AssociationType', '2'), ('AssociatedMePoint', '0x102'),
              ('InputTPID', '0x8100'), ('OutputTPID', '0x8100'), ('DsMode', '0')], rules([])),
            ([('EntityId', '0xe01'), ('AssociationType', '10'), ('AssociatedMePoint', '0x601'),
              ('InputTPID', '0x8100'), ('OutputTPID', '0x8100'), ('DsMode', '0')], rules(['209', '400', '500']))]),
    },
    'quick_get': lambda: {
        'pon': {'sn': 'DLKI12345678', 'ploam': '0123456789', 'loid': '', 'loid_pw': ''},
        'wifi': [{'radio': 0, 'band': '5g', 'ssid': 'NijikaWrt 5GHz', 'key': 'nijika-sample', 'enabled': True},
                 {'radio': 1, 'band': '2g', 'ssid': 'NijikaWrt 2.4GHz', 'key': 'nijika-sample', 'enabled': True}],
        'voip': [{'line': 0, 'enable': True, 'addr': 'sip.example.net', 'port': '5060', 'domain': 'example.net', 'number': '0312345678',
                  'login': '0312345678', 'password': 'secret', 'display': 'Home'},
                 {'line': 1, 'enable': False, 'addr': '', 'port': '5060', 'domain': '', 'number': '', 'login': '', 'password': '', 'display': ''}],
        # Same layout as a TM Unifi unit: Internet PPPoE, IPTV bridge, voice, TR-069.
        'wan': {'table': 'ATM_VC_TBL', 'num': 4, 'records': [
            {'ifIndex': '65536', 'ChannelMode': '2', 'applicationtype': '2', 'vlan': '1', 'vid': '500', 'vprio': '0', 'MTU': '1492', 'pppUser': 'user@unifi', 'pppPasswd': 'secret', 'WanName': ''},
            {'ifIndex': '130817', 'ChannelMode': '0', 'applicationtype': '4', 'vlan': '1', 'vid': '600', 'vprio': '0', 'MTU': '1500', 'pppUser': '', 'pppPasswd': '', 'WanName': ''},
            {'ifIndex': '130818', 'ChannelMode': '1', 'applicationtype': '8', 'vlan': '1', 'vid': '400', 'vprio': '0', 'MTU': '1500', 'pppUser': '', 'pppPasswd': '', 'WanName': ''},
            {'ifIndex': '130819', 'ChannelMode': '1', 'applicationtype': '1', 'vlan': '1', 'vid': '209', 'vprio': '0', 'MTU': '1500', 'pppUser': '', 'pppPasswd': '', 'WanName': ''}]},
        'isp': [{'id': 'unifi', 'label': 'TM Unifi (Malaysia)', 'vid': 500, 'prio': 1, 'mtu': 1492},
                {'id': 'maxis', 'label': 'TM HSBB - Maxis (Malaysia)', 'vid': 621, 'prio': 1, 'mtu': 1492},
                {'id': 'time', 'label': 'TIME dotCom (Malaysia)', 'vid': 499, 'prio': 1, 'mtu': 1492}],
    },
    'ident_get': lambda: {
        'current': {'PON_VENDOR_ID': 'DLNK', 'GPON_ONU_MODEL': 'DPN-FX3060V', 'HW_CWMP_PRODUCTCLASS': 'DPN-FX3060V', 'HW_CWMP_MANUFACTURER': 'DLINK',
                    'HW_HWVER': 'A1', 'OMCI_OLT_MODE': '0', 'OMCI_SW_VER1': 'V1.1.2', 'OMCI_SW_VER2': 'V1.1.2', 'OMCI_VENDOR_PRODUCT_CODE': '0',
                    'OMCI_TM_OPT': '0', 'OUI': '11,11,11', 'HW_SERIAL_NO': 'SAMPLE0001', 'OMCI_CUSTOM_BDP': '128', 'OMCI_CUSTOM_RDP': '4', 'OMCI_CUSTOM_ME': '262400'},
        'defaults': {'PON_VENDOR_ID': 'DLNK', 'GPON_ONU_MODEL': 'DPN-FX3060V', 'HW_HWVER': 'A1', 'OMCI_OLT_MODE': '0'},
        'presets': [{'id': 'nijika', 'label': 'NIJIKA (default)'}, {'id': 'hg8145x6', 'label': 'Huawei HG8145X6'},
                    {'id': 'hg8240h5', 'label': 'Huawei HG8240H5'}, {'id': 'g-240g-e', 'label': 'Nokia G-240G-E'}],
    },
    'boot_get': lambda: {'running': 1, 'active': '1', 'commit': '1', 'tryactive': '2',
                         'banks': [{'bank': 0, 'version': 'DPN-FX3060V_V1.1.2', 'valid': '1'},
                                   {'bank': 1, 'version': 'NijikaWrt_r1_25.12.5', 'valid': '1'}]},
    'mib_all': lambda: {
        'values': {'GPON_SN': 'DLKI12345678', 'GPON_PLOAM_PASSWD': '0123456789', 'PON_VENDOR_ID': 'DLNK', 'LAN_IP_ADDR': '192.168.0.1',
                   'SSID': 'NijikaWrt 5GHz', 'WLAN1_SSID': 'NijikaWrt 2.4GHz', 'OMCI_OLT_MODE': '0', 'NTP_SERVER_HOST1': 'pool.ntp.org',
                   'WLAN_CHANNELWIDTH': '3', 'WLAN1_CHANNEL': '11', 'LOID': '', 'OMCI_TM_OPT': '0'},
        'chains': [{'id': 3004, 'name': 'ATM_VC_TBL', 'num': 2, 'max': 8}, {'id': 3501, 'name': 'WLAN_MBSSIB_TBL', 'num': 6, 'max': 6},
                   {'id': 3502, 'name': 'WLAN1_MBSSIB_TBL', 'num': 6, 'max': 6}, {'id': 3009, 'name': 'SW_PORT_TBL', 'num': 5, 'max': 5}],
    },
    'fw_status': lambda: {'running': False, 'rc': 0, 'log': 'running bank: 1, writing bank: 0\n...'},
    'fw_check': lambda: {'valid': True, 'format': 'sysupgrade', 'target_version': 'DPN-FX3060V_V1.1.2', 'target_stock': True, 'version': 'NijikaWrt_r2_25.12.5', 'size': 28364800, 'target': 0},
}


def nijika_call(method, args):
    if method in DATA:
        return DATA[method]()
    if method == 'me':
        cls = int(args.get('class', 0))
        olt = DATA['olt']()
        return olt.get('me%d' % cls) or me(cls, 'Sample', [])
    if method == 'provision':
        # real omci_map_json output: TM Unifi (Nokia OLT) at O5, or without
        # fibre (MOCK_PROVISION=nofiber)
        name = 'provision-%s.json' % os.environ.get('MOCK_PROVISION', 'unifi')
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', name)) as f:
            return json.load(f)
    if method == 'chain':
        return DATA['quick_get']()['wan'] if args.get('table') == 'ATM_VC_TBL' else {'table': args.get('table'), 'num': 0, 'records': []}
    if method == 'diag':
        return {'cmd': args.get('cmd'), 'output': 'ONU state: Operation State(O5)\n(sample output)'}
    if method == 'mib_get':
        mib = UCI['rtk']['mib']
        return {'values': {k: mib.get(k, '') for k in args.get('keys', [])}}
    if method == 'voip_get':
        def proxy(chid, p):
            return {'enable': '1' if p == 0 and chid == 0 else '0', 'display_name': 'Line %d' % (chid + 1),
                    'number': '0312345678' if chid == 0 else '', 'login_id': '0312345678@ims.tm.com.my' if chid == 0 else '',
                    'password': 'mock' if chid == 0 else '', 'addr': 'ims.tm.com.my' if p == 0 else '',
                    'port': '5060', 'domain_name': 'ims.tm.com.my' if p == 0 else ''}
        return {'lines': [{'line': c, 'proxies': [proxy(c, 0), proxy(c, 1)]} for c in (0, 1)]}
    if method == 'voip_set':
        return {'ok': len(args.get('values', [])), 'failed': [], 'applied': ['voip'], 'reboot_required': False}
    if method == 'wan_delete':
        return {'ok': True}
    if method == 'wps':
        if args.get('action') == 'pin' and not str(args.get('pin', '')).isdigit():
            return {'error': 'the PIN has 4 or 8 digits'}
        return {'ok': True}
    if method == 'wan_status':
        return {'wans': [
            {'index': 0, 'name': 'PON_0', 'ifname': 'ppp0', 'ifIndex': '65536', 'ChannelMode': '2', 'ChannelAddrType': '0',
             'applicationtype': '2', 'vid': '500', 'default_route': True, 'ip4': '203.0.113.7', 'prefix4': '32',
             'gw4': '198.51.100.1', 'ip6': '2001:db8:1::7/64', 'state': 'up'},
            {'index': 1, 'name': 'PON_2', 'ifname': 'nas0_2', 'ifIndex': '130818', 'ChannelMode': '1', 'ChannelAddrType': '1',
             'applicationtype': '8', 'vid': '400', 'default_route': False, 'ip4': '10.198.82.51', 'prefix4': '22',
             'gw4': '10.198.80.1', 'ip6': '', 'state': 'up'},
            {'index': 2, 'name': 'PON_3', 'ifname': 'nas0_3', 'ifIndex': '130819', 'ChannelMode': '1', 'ChannelAddrType': '1',
             'applicationtype': '1', 'vid': '209', 'default_route': False, 'ip4': '', 'prefix4': '', 'gw4': '', 'ip6': '',
             'state': 'connecting'}]}
    if method == 'portfw_get':
        return {'enable': True, 'max': 32, 'chain': {'table': 'PORT_FW_TBL', 'num': 2, 'records': [
            {'IP': '192.168.0.10', 'PortStart': '443', 'PortEnd': '443', 'Protocol': '1', 'Comment': 'nas', 'OutInf': '65535',
             'enable': '1', 'remotehost': '0.0.0.0', 'externalportStart': '8443', 'externalportEnd': '8443', 'Dynamic': '0'},
            {'IP': '192.168.0.20', 'PortStart': '3074', 'PortEnd': '3074', 'Protocol': '2', 'Comment': 'upnp game', 'OutInf': '65536',
             'enable': '1', 'remotehost': '0.0.0.0', 'externalportStart': '3074', 'externalportEnd': '3074', 'Dynamic': '1'}]}}
    if method == 'portfw_set':
        return {'ok': len(args.get('rules', [])), 'applied': ['portfw'], 'reboot_required': False}
    if method == 'easymesh_get':
        return {'role': UCI['rtk']['mib'].get('_role', 'controller'), 'pinned': 'controller', 'name': UCI['rtk']['mib'].get('MAP_DEVICE_NAME', ''), 'running': []}
    if method == 'easymesh_set':
        UCI['rtk']['mib']['_role'] = args.get('role')
        return {'ok': True, 'applied': ['wlan'], 'reboot_required': False}
    if method == 'easymesh_pair':
        return {'ok': True}
    if method in ('mib_set',):
        return {'ok': len(args.get('values', [])), 'failed': [], 'applied': ['wlan'], 'reboot_required': False}
    return {'ok': True, 'message': 'mock: %s %s' % (method, json.dumps(args))}


UCI = {'nijika': {
    'vendor': {'.type': 'vendor', '.name': 'vendor', '.anonymous': False, 'boa': 'hidden', 'live_apply': '1', 'console': '1', 'inetd': '0',
               'tr069': '0', 'snmp': '0',
               'lan_mgmt': '1', 'lan_ifname': 'br0'},
    'banner': {'.type': 'banner', '.name': 'banner', '.anonymous': False, 'animate': 'always', 'color': 'auto'},
    'pon': {'.type': 'pon', '.name': 'pon', '.anonymous': False, 'cache_ttl': '5'},
    'doh': {'.type': 'doh', '.name': 'doh', '.anonymous': False, 'enabled': '1',
            'resolver_url': 'https://b.hitoha.moe/dns-query', 'bootstrap_dns': '1.1.1.1,8.8.8.8', 'listen_port': '5053'},
    'firewall': {'.type': 'firewall', '.name': 'firewall', '.anonymous': False, 'spi_ipv4': 'off', 'spi_ipv6': 'off'},
    'ui': {'.type': 'ui', '.name': 'ui', '.anonymous': False, 'developer': '0'},
    'wifi': {'.type': 'wifi', '.name': 'wifi', '.anonymous': False, 'bss_color_wlan0': '1', 'bss_color_wlan1': '1'}}}


def rtk_uci():
    """/etc/config/rtk as uci-mirror builds it: ATM_VC_TBL records from the
    real A1 capture (tests/fixtures), sample WiFi records and scalars."""
    values = {'mib': {'.type': 'mib', '.name': 'mib', '.anonymous': False,
                      'LAN_IP_ADDR': '192.168.0.1', 'LAN_SUBNET': '255.255.255.0', 'LAN_DHCP': '0', 'DHCP_MODE': '2',
                      'LAN_DHCP_POOL_START': '192.168.0.2', 'LAN_DHCP_POOL_END': '192.168.0.252',
                      'LAN_DHCP_LEASE': '86400', 'LAN_DHCP_DOMAIN': 'dlinkrouter.local.',
                      'LOID': '', 'LOID_PASSWD': '', 'GPON_PLOAM_PASSWD': '0123456789', 'GPON_SN': 'DLKI12345678',
                      'DEVICE_TYPE': '1', 'OMCI_OLT_MODE': '0', 'LAN_ENABLE_IP2': '0', 'LAN_IP_ADDR2': '192.168.100.1', 'LAN_SUBNET2': '255.255.255.0', 'MP_MODE': '4',
                      'WLAN_BLOCK_ETH2WIR': '0', 'LAN_DHCP_GATEWAY': '192.168.0.1',
                      'SW_PORT_TBL.0.Enable': '1', 'SW_PORT_TBL.1.Enable': '1', 'SW_PORT_TBL.2.Enable': '1',
                      'SW_PORT_TBL.3.Enable': '1',
                      'AUTO_CHANNEL': '1', 'CHANNEL': '44', 'WLAN_CHANNELWIDTH': '3', 'WLAN_RFPOWER_SCALE': '0',
                      'WLAN1_AUTO_CHANNEL': '0', 'WLAN1_CHANNEL': '11', 'WLAN1_CHANNELWIDTH': '1', 'WLAN1_RFPOWER_SCALE': '0',
                      'SSID': 'NijikaWrt 5GHz', 'WLAN1_SSID': 'NijikaWrt 2.4GHz',
                      'WLAN_BAND': '204', 'WLAN1_BAND': '139', 'WLAN_OFDMA_ENABLED': '0', 'WLAN1_OFDMA_ENABLED': '0',
                      'BEACON_INTERVAL': '100', 'DTIM_PERIOD': '1', 'WLAN1_BEACON_INTERVAL': '300', 'WLAN1_DTIM_PERIOD': '1',
                      'WSC_DISABLE': '0', 'WLAN1_WSC_DISABLE': '0', 'MAP_CONTROLLER': '3', 'MAP_DEVICE_NAME': 'MeshAuto_5a2e',
                      'DMZ_ENABLE': '0', 'DMZ_IP': '0.0.0.0', 'DMZ_WAN': '65535'}}
    fix = os.path.join(TOP, 'tests', 'fixtures', 'flash-get-atm_vc_tbl.txt')
    sec = None
    for line in open(fix):
        line = line.rstrip('\r\n')
        if line.startswith('ATM_VC_TBL.') and line.endswith(':'):
            n = line[len('ATM_VC_TBL.'):-1]
            sec = {'.type': 'ATM_VC_TBL', '.name': 'ATM_VC_TBL_' + n, '.anonymous': False}
            values[sec['.name']] = sec
        elif sec is not None and '=' in line:
            k, v = line.split('=', 1)
            sec[k.strip()] = v.strip()
    for tbl, ssids in (('WLAN_MBSSIB_TBL', ['NijikaWrt 5GHz', 'EasyMeshBH-mock', 'Guest 5GHz', '', '', 'repeater']),
                       ('WLAN1_MBSSIB_TBL', ['NijikaWrt 2.4GHz', '', '', '', '', 'repeater'])):
        for i, ssid in enumerate(ssids):
            name = '%s_%d' % (tbl, i)
            values[name] = {'.type': tbl, '.name': name, '.anonymous': False, 'ssid': ssid,
                            'wlanDisabled': '0' if ssid else '1', 'encrypt': '20' if i == 0 else '4',
                            'wpaPSK': 'mock-passphrase', 'wpaAuth': '2', 'dotIEEE80211W': '1', 'sha256': '0',
                            'hidessid': '0', 'userIsolation': '0' if i == 0 else '1',
                            'wlanBand': '204' if tbl == 'WLAN_MBSSIB_TBL' else '139', 'WLAN_FT_ENABLE': '0',
                            'WLAN_FT_MDID': 'a1b2', 'WLAN_FT_OVER_DS': '1', 'rm_activated': '1', 'BssTransEnable': '1',
                            'wmmEnabled': '1', 'mc2u_disable': '0', 'wsc_disabled': '0' if i == 0 else '1',
                            'wpaGroupRekeyTime': '86400',
                            'multiap_bss_type': '96' if ssid.startswith('EasyMeshBH') else '32'}
    return values


UCI['rtk'] = rtk_uci()


def ubus(obj, method, args):
    if obj == 'nijika':
        sys.stderr.write('ubus nijika %s %s\n' % (method, json.dumps(args)))
        return [0, nijika_call(method, args)]
    if obj == 'uci' and method in ('set', 'delete', 'add', 'apply'):
        # what a page saved, for checking payloads; kept so the page reads
        # it back like on the router
        sys.stderr.write('ubus uci %s %s\n' % (method, json.dumps(args, sort_keys=True)))
        if method == 'set':
            sec = UCI.get(args.get('config'), {}).get(args.get('section'))
            if sec is not None:
                sec.update(args.get('values', {}))
    if obj == 'session' and method == 'access':
        return [0, {'access': True}]
    if obj == 'uci' and method == 'get':
        return [0, {'values': UCI.get(args.get('config'), {})}]
    if obj == 'uci' and method == 'changes':
        return [0, {'changes': {}}]
    if obj == 'luci' and method == 'getFeatures':
        return [0, {}]
    return [0, {}]


PAGE = '''<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>NijikaWrt | %(view)s</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/luci-static/bootstrap/cascade.css">
<script src="/luci-static/resources/cbi.js"></script>
<script>
	var mq = window.matchMedia('(prefers-color-scheme: dark)');
	document.querySelector(':root').setAttribute('data-darkmode', mq.matches);
</script>
</head><body class="lang_en" data-page="admin-nijika-%(view)s">
<header><a class="brand" href="/">NijikaWrt (mock)</a><ul class="nav" id="topmenu">%(menu)s</ul><div id="indicators" class="pull-right"></div></header>
<div id="maincontent" class="container">
<script src="/luci-static/resources/luci.js"></script>
<script>
L = new LuCI({"media":"/luci-static/bootstrap","resource":"/luci-static/resources","scriptname":"/cgi-bin/luci",
 "pathinfo":"/admin/nijika/%(view)s","documentroot":"/www","requestpath":["admin","nijika","%(view)s"],
 "dispatchpath":["admin","nijika","%(view)s"],"pollinterval":5,"ubuspath":"/ubus/","sessionid":"mock","token":"mock",
 "nodespec":{"action":{"type":"view","path":"nijika/%(view)s"}},"apply_rollback":90,"apply_holdoff":4,"apply_timeout":5,"apply_display":1.5});
</script>
<div id="view"><div class="spinning">Loading view…</div>
<script>L.require('ui').then(function(ui) { ui.instantiateView('nijika/%(view)s'); });</script></div>
</div></body></html>'''


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WWW, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write('%s\n' % (fmt % args))

    def send_body(self, body, ctype):
        data = body.encode()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/':
            links = ''.join('<li><a href="/cgi-bin/luci/admin/nijika/%s">%s</a></li>' % (v, v) for v in VIEWS)
            return self.send_body('<h1>NijikaWrt LuCI mock</h1><ul>%s</ul>' % links, 'text/html')
        if path.startswith('/cgi-bin/luci/admin/nijika/'):
            view = path.rsplit('/', 1)[1]
            if view in VIEWS:
                menu = ''.join('<li><a href="/cgi-bin/luci/admin/nijika/%s">%s</a></li>' % (v, v) for v in VIEWS)
                return self.send_body(PAGE % {'view': view, 'menu': menu}, 'text/html')
        if path.startswith('/cgi-bin/luci/admin/translations'):
            return self.send_body('', 'application/javascript')
        if path.startswith('/cgi-bin/luci/admin/menu'):
            return self.send_body('{}', 'application/json')
        return super().do_GET()

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)) or 0)
        if not self.path.startswith('/ubus'):
            return self.send_body('{}', 'application/json')
        req = json.loads(body or b'[]')
        reqs = req if isinstance(req, list) else [req]
        res = []
        for r in reqs:
            p = r.get('params', [])
            out = ubus(p[1], p[2], p[3] if len(p) > 3 else {}) if r.get('method') == 'call' else [0, {}]
            res.append({'jsonrpc': '2.0', 'id': r.get('id'), 'result': out})
        self.send_body(json.dumps(res if isinstance(req, list) else res[0]), 'application/json')


if __name__ == '__main__':
    if not os.path.isdir(os.path.join(WWW, 'luci-static')):
        sys.exit('LuCI www not found at %s (run ./build.sh rootfs assemble first)' % WWW)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), Handler) as srv:
        print('LuCI mock on http://127.0.0.1:%d/' % PORT)
        srv.serve_forever()
