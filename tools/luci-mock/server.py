#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only

"""
LuCI mock for developing luci-app-nijika without the router.

Serves the LuCI client framework from a built rootfs (build/stage/www) and
answers the ubus JSON-RPC calls of the "nijika" rpcd object with synthetic
sample data (no real device secrets).

    ./build.sh rootfs assemble          # once, produces build/stage/www
    python3 tools/luci-mock/server.py   # http://127.0.0.1:8080/

Views: /cgi-bin/luci/admin/nijika/<status|quicksetup|omci|identity|mib|firmware|settings>
Login page: /cgi-bin/luci/login. LUCI_THEME=perfect (default) or bootstrap
picks the page chrome; package/*/htdocs is served over the built www, so
theme and view edits show up without a rebuild.
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
THEME = os.environ.get('LUCI_THEME', 'perfect')
HTDOCS = sorted(os.path.join(TOP, 'package', p, 'htdocs') for p in os.listdir(os.path.join(TOP, 'package'))
                if os.path.isdir(os.path.join(TOP, 'package', p, 'htdocs')))
VIEWS = ['status', 'quicksetup', 'wan', 'lan', 'wlan', 'portfw', 'dmz', 'qos', 'voip', 'upnp', 'ddns', 'wireguard', 'gpon', 'provision', 'identity', 'mib', 'firmware', 'settings']
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
    if method == 'ddns_status':
        # MOCK_DDNS=public: the WAN has a public address; default: behind CGNAT
        now = int(time.time())
        pub = os.environ.get('MOCK_DDNS') == 'public'
        st = {'running': True, 'now': now, 'time': str(now - 20), 'wan': 'ppp0',
              'wan_ip': '203.0.113.7' if pub else '100.70.12.34', 'kind': 'public' if pub else 'cgnat',
              'ip': '203.0.113.7' if pub else '198.51.100.23',
              'source': 'wan' if pub else 'http://ip1.dynupdate.no-ip.com/', 'lookup_error': '',
              'hosts': {}, 'stock': [{'provider': 'noip', 'hostname': 'myhome.ddns.net', 'enabled': True}]}
        results = [('good', 'example.org: updated; www.example.org: updated', now - 300),
                   ('failed', 'no valid token in the update URL', now - 60),
                   ('error', 'nohost.example.net: Could not resolve host: api.dynu.com', now - 900)]
        for i, name in enumerate(n for n, v in UCI['nijika'].items() if v.get('.type') == 'ddns_host'):
            r = results[i % len(results)]
            st['hosts'][name] = {'id': '%016x' % i, 'result': r[0], 'message': r[1], 'ip': st['ip'],
                                 'time': str(r[2]), 'next': str(now + 240) if r[0] == 'error' else ''}
        return st
    if method == 'wg_status':
        now = int(time.time())
        pk = [v.get('public_key') for v in UCI['nijika'].values() if v.get('.type') == 'wireguard_peer']
        return {'enabled': True, 'up': True, 'module': True, 'module_available': True, 'kernel': '5.10.70', 'error': '',
                'public_key': 'MOCKrouterPublicKeyAAAAAAAAAAAAAAAAAAAAAAA=', 'listen_port': 51820,
                'endpoint': os.environ.get('MOCK_WG_ENDPOINT', 'example.org'), 'endpoint_source': 'ddns',
                'wan_kind': 'public' if os.environ.get('MOCK_DDNS') == 'public' else 'cgnat', 'now': now,
                'peers': {pk[0]: {'endpoint': '203.0.113.50:41000', 'latest_handshake': now - 42, 'rx': 52428800, 'tx': 7340032}} if pk else {}}
    if method == 'wg_keys':
        if args.get('private_key'):
            return {'public_key': 'MOCKpub' + 'B' * 36 + '='}
        return {'private_key': 'MOCKpriv' + 'C' * 35 + '=', 'public_key': 'MOCKpub' + 'D' * 36 + '=',
                'preshared_key': 'MOCKpsk' + 'E' * 36 + '='}
    if method == 'wg_client':
        conf = ('[Interface]\nPrivateKey = MOCKprivCCCC=\nAddress = 10.7.0.2/32\nDNS = 192.168.0.1\n\n'
                '[Peer]\nPublicKey = MOCKrouterPublicKeyAAAAAAAAAAAAAAAAAAAAAAA=\nAllowedIPs = 0.0.0.0/0\n'
                'Endpoint = example.org:51820\nPersistentKeepalive = 25')
        qr = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><rect width="21" height="21" fill="#fff"/>'
              '<rect x="1" y="1" width="7" height="7"/><rect x="13" y="1" width="7" height="7"/><rect x="1" y="13" width="7" height="7"/></svg>')
        return {'config': conf, 'qr': qr}
    if method == 'ddns_update':
        return {'ok': True, 'running': True}
    if method == 'portfw_get':
        return {'enable': True, 'max': 32, 'chain': {'table': 'PORT_FW_TBL', 'num': 2, 'records': [
            {'IP': '192.168.0.10', 'PortStart': '443', 'PortEnd': '443', 'Protocol': '1', 'Comment': 'nas', 'OutInf': '65535',
             'enable': '1', 'remotehost': '0.0.0.0', 'externalportStart': '8443', 'externalportEnd': '8443', 'Dynamic': '0'},
            {'IP': '192.168.0.20', 'PortStart': '3074', 'PortEnd': '3074', 'Protocol': '2', 'Comment': 'upnp game', 'OutInf': '65536',
             'enable': '1', 'remotehost': '0.0.0.0', 'externalportStart': '3074', 'externalportEnd': '3074', 'Dynamic': '1'}]}}
    if method == 'portfw_set':
        return {'ok': len(args.get('rules', [])), 'applied': ['portfw'], 'reboot_required': False}
    if method == 'qos_get':
        return QOS
    if method == 'qos_set':
        qos_store(args)
        return {'ok': True, 'applied': ['qos'], 'reboot_required': False}
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
    'wifi': {'.type': 'wifi', '.name': 'wifi', '.anonymous': False, 'bss_color_wlan0': '1', 'bss_color_wlan1': '1'},
    'ddns': {'.type': 'ddns', '.name': 'ddns', '.anonymous': False, 'enabled': '1', 'interface': 'auto',
             'ip_url': ['http://ip1.dynupdate.no-ip.com/', 'https://api.ipify.org/', 'https://ipv4.icanhazip.com/'],
             'check_interval': '600', 'force_interval': '86400'},
    'wireguard': {'.type': 'wireguard', '.name': 'wireguard', '.anonymous': False, 'enabled': '1', 'listen_port': '51820',
                  'address': ['10.7.0.1/24'], 'private_key': 'MOCKrouterPrivateKeyAAAAAAAAAAAAAAAAAAAAAA='},
    'cfg1a2b3c': {'.type': 'wireguard_peer', '.name': 'cfg1a2b3c', '.anonymous': True, 'enabled': '1', 'description': 'phone',
                  'public_key': 'MOCKphonePublicKeyAAAAAAAAAAAAAAAAAAAAAAAA=', 'private_key': 'MOCKphonePrivateKeyAAAAAAAAAAAAAAAAAAAAAAA=',
                  'allowed_ips': ['10.7.0.2/32'], 'client_allowed_ips': ['0.0.0.0/0']},
    'cfg1d4e5f': {'.type': 'wireguard_peer', '.name': 'cfg1d4e5f', '.anonymous': True, 'enabled': '1', 'description': 'office',
                  'public_key': 'MOCKofficePublicKeyAAAAAAAAAAAAAAAAAAAAAAA=', 'allowed_ips': ['10.7.0.3/32', '192.168.50.0/24'],
                  'endpoint_host': 'office.example.net', 'endpoint_port': '51820', 'persistent_keepalive': '25'},
    'cfg0a1b2c': {'.type': 'ddns_host', '.name': 'cfg0a1b2c', '.anonymous': True, 'enabled': '1', 'provider': 'cloudflare',
                  'hostname': 'example.org,www.example.org', 'zone': 'example.org', 'email': '', 'api_key': 'mock-token'},
    'cfg0b3d4e': {'.type': 'ddns_host', '.name': 'cfg0b3d4e', '.anonymous': True, 'enabled': '1', 'provider': 'afraid',
                  'url': 'mock'},
    'cfg0c5f60': {'.type': 'ddns_host', '.name': 'cfg0c5f60', '.anonymous': True, 'enabled': '1', 'provider': 'dynu',
                  'hostname': 'nohost.example.net', 'username': 'mock', 'password': 'mock'}}}


# Stock IP QoS as `flash all` / `flash get` show it on an A1 (V1.1.2): the
# queue tables' factory records, one classification rule, one rate limit.
def qos_queue(i, wifi):
    return {'outif': '65535', 'prior': str(i + 1), 'weight': '0', 'shaping_rate': '0', 'shaping_burst_size': '0',
            'enable': '1', 'desc': '', 'QueueInstNum': str(i + 1), 'car': '0', 'wifiPrior': str(wifi)}


QOS = {
    'mib': {'ENABLE_QOS': '0', 'QOS_POLICY': '0', 'TOTAL_BANDWIDTH_LIMIT': '0', 'TOTAL_BANDWIDTH': '1000000',
            'ENABLE_DSCP_MARK': '1', 'ENABLE_1P': '2', 'ENABLE_DOWNSTREAM_QOS': '0', 'QOS_DOWNSTREAM_POLICY': '0',
            'TOTAL_DOWNSTREAM_BANDWIDTH_LIMIT': '0', 'TOTAL_DOWNSTREAM_BANDWIDTH': '1000000',
            'ENABLE_DOWNSTREAM_DSCP_MARK': '1', 'ENABLE_DOWNSTREAM_1P': '2'},
    'rules_max': 64, 'tc_max': 64,
    'queues': {'table': 'IP_QOS_QUEUE_TBL', 'num': 8, 'records': [qos_queue(i, 0) for i in range(8)]},
    'dqueues': {'table': 'IP_QOS_DOWNSTREAM_QUEUE_TBL', 'num': 8,
                'records': [qos_queue(i, w) for i, w in enumerate((1, 0, 0, 1, 2, 2, 3, 3))]},
    'rules': {'table': 'IP_QOS_TBL', 'num': 1, 'records': [
        {'direction': '0', 'TYPE': '0', 'Name': 'gaming_pc', 'SrcIP': '192.168.0.50', 'SrcMask': '32', 'SrcPort': '0',
         'SrcPortRangeMax': '0', 'DstIP': '0.0.0.0', 'DstMask': '0', 'DstPort': '0', 'DstPortRangeMax': '0', 'Protocol': '3',
         'SMac': '000000000000', 'DMac': '000000000000', 'PhyPort': '0', 'qosDscp': '0', 'vlan1p': '0', 'OutInf': '65535',
         'Prior': '1', 'm_1p': '0', 'm_dscp': '185', 'Enable': '1', 'QoSOrder': '0', 'IPVersion': '1', 'SrcIP6': '::',
         'DstIP6': '::', 'SrcIP6PrefixLen': '0', 'DstIP6PrefixLen': '0', 'applicationtype': '0', 'classtype': '0'}]},
    'tc': {'table': 'IP_QOS_TC_TBL', 'num': 1, 'records': [
        {'entryid': '1', 'ifIndex': '65535', 'Srcip': '192.168.0.60', 'srcmask': '32', 'dstip': '0.0.0.0', 'dstmask': '0',
         'srcport': '0', 'dstport': '0', 'protocol': '0', 'rate': '10240', 'IPVersion': '1', 'SrcIP6': '::', 'DstIP6': '::',
         'SrcIP6PrefixLen': '0', 'DstIP6PrefixLen': '0', 'direction': '1', 'vlanID': '0', 'ssid': ''}]},
}


def qos_store(args):
    """qos_set: keep what was saved (scalars, queues), echo the rest to stderr."""
    sys.stderr.write('qos_set %s\n' % json.dumps(args, sort_keys=True))
    for k, v in (args.get('mib') or {}).items():
        QOS['mib'][k] = str(v)
    for key, part in (('queues', 'queues'), ('dqueues', 'dqueues')):
        for rec, q in zip(QOS[part]['records'], args.get(key) or []):
            rec['enable'] = str(q.get('enable', rec['enable']))
            rec['weight'] = str(q.get('weight', rec['weight']))
            if 'car' in q:
                rec['car'] = str(q['car'])
            if 'wifi' in q:
                rec['wifiPrior'] = str(q['wifi'])


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
                      'DMZ_ENABLE': '0', 'DMZ_IP': '0.0.0.0', 'DMZ_WAN': '65535',
                      'UPNP': '0', 'UPNP_EXT_ITF': '65535'}}
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


# Page chrome per theme, mirroring themes/<theme>/header.ut + footer.ut.
CHROME = {
    'bootstrap': {
        'css': '<link rel="stylesheet" href="/luci-static/bootstrap/cascade.css">',
        'dark': '<script>document.querySelector(":root").setAttribute("data-darkmode", '
                'window.matchMedia("(prefers-color-scheme: dark)").matches);</script>',
        'brand': '<a class="brand" href="/">NijikaWrt (mock)</a>',
        'footer': '',
    },
    'perfect': {
        'css': '<link rel="stylesheet" href="/luci-static/bootstrap/cascade.css">'
               '<link rel="stylesheet" media="only screen and (max-device-width: 854px)" href="/luci-static/bootstrap/mobile.css">'
               '<link rel="stylesheet" href="/luci-static/perfect/perfect.css">'
               '<link rel="icon" href="/luci-static/perfect/logo_48.png" sizes="48x48">',
        'dark': '<script>document.querySelector(":root").setAttribute("data-darkmode", "false");</script>',
        'brand': '<a class="perfect-brand" href="/"><img src="/luci-static/perfect/brand.svg" alt="Perfect" width="111" height="34">'
                 '<span class="perfect-host">NijikaWrt (mock)</span></a>',
        'footer': '<footer><span>Powered by <a href="#">LuCI (mock)</a> / <a href="#">OpenWrt 25.12.5</a></span>'
                  '<ul class="breadcrumb pull-right" id="modemenu"><li class="active"><a href="#">Administration</a></li></ul></footer>',
    },
}

PAGE = '''<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>NijikaWrt | %(view)s</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
%(css)s
<script src="/luci-static/resources/cbi.js"></script>
%(dark)s
</head><body class="lang_en" data-page="admin-nijika-%(view)s">
<header>%(brand)s<ul class="nav" id="topmenu">%(menu)s</ul><div id="indicators" class="pull-right"></div></header>
<div id="maincontent" class="container">
<script src="/luci-static/resources/luci.js"></script>
<script>
L = new LuCI({"media":"/luci-static/%(theme)s","resource":"/luci-static/resources","scriptname":"/cgi-bin/luci",
 "pathinfo":"/admin/nijika/%(view)s","documentroot":"/www","requestpath":["admin","nijika","%(view)s"],
 "dispatchpath":["admin","nijika","%(view)s"],"pollinterval":5,"ubuspath":"/ubus/","sessionid":"mock","token":"mock",
 "nodespec":{"action":{"type":"view","path":"nijika/%(view)s"}},"apply_rollback":90,"apply_holdoff":4,"apply_timeout":5,"apply_display":1.5});
</script>
<div id="view"><div class="spinning">Loading view…</div>
<script>L.require('ui').then(function(ui) { ui.instantiateView('nijika/%(view)s'); });</script></div>
</div>%(footer)s</body></html>'''

# themes/perfect/sysauth.ut with sample values (?error shows the failed login)
LOGIN = '''<!DOCTYPE html>
<html lang="en" data-darkmode="false"><head><meta charset="utf-8"><title>NijikaWrt (mock)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
%(css)s
</head><body class="lang_en perfect-blank" data-page="">
<main class="perfect-login">
	<section class="perfect-login-panel">
		<img class="perfect-login-logo" src="/luci-static/perfect/brand.svg" alt="Perfect" width="148" height="45">
		<span class="perfect-pill">NijikaWrt (mock)</span>
		<h1>Authorization Required</h1>
		<p class="perfect-login-lead">Please enter your username and password.</p>
		<form method="get" class="perfect-login-card" id="perfect-login" action="/cgi-bin/luci/admin/nijika/status">
			%(error)s
			<label for="luci_username">Username</label>
			<input name="luci_username" id="luci_username" type="text" autocomplete="username" value="root">
			<label for="luci_password">Password</label>
			<input name="luci_password" id="luci_password" type="password" autocomplete="current-password">
			<button type="submit" class="btn cbi-button-action important">Log in</button>
		</form>
	</section>
	<div class="perfect-login-art" aria-hidden="true">
		<img src="/luci-static/perfect/login-cat.webp" alt="" width="636" height="430">
	</div>
</main>
</body></html>'''


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WWW, **kw)

    def translate_path(self, path):
        # package/*/htdocs first (live edits), then the built www
        full = super().translate_path(path)
        rel = os.path.relpath(full, self.directory)
        if rel != '.' and not rel.startswith('..'):
            for root in HTDOCS:
                if os.path.isfile(os.path.join(root, rel)):
                    return os.path.join(root, rel)
        return full

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
            links += '<li><a href="/cgi-bin/luci/login">login</a></li>'
            return self.send_body('<h1>NijikaWrt LuCI mock</h1><ul>%s</ul>' % links, 'text/html')
        if path.startswith('/cgi-bin/luci/admin/nijika/'):
            view = path.rsplit('/', 1)[1]
            if view in VIEWS:
                menu = ''.join('<li><a href="/cgi-bin/luci/admin/nijika/%s">%s</a></li>' % (v, v) for v in VIEWS)
                chrome = CHROME.get(THEME, CHROME['bootstrap'])
                return self.send_body(PAGE % dict(chrome, view=view, menu=menu, theme=THEME), 'text/html')
        if path == '/cgi-bin/luci/login':
            error = ('<div class="alert-message error">Invalid username and/or password! Please try again.</div>'
                     if 'error' in self.path else '')
            return self.send_body(LOGIN % {'css': CHROME['perfect']['css'], 'error': error}, 'text/html')
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
