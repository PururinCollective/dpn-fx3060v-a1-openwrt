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
VIEWS = ['status', 'quicksetup', 'omci', 'identity', 'mib', 'firmware', 'settings']
BOOT = time.time()


def me(cls, name, insts):
    return {'class': cls, 'name': name, 'instances': [
        {'attrs': [[k, v] for k, v in attrs], 'raw': '\n'.join('%s: %s' % (k, v) for k, v in attrs) + ('\n' + raw if raw else '')}
        for attrs, raw in insts]}


RULES = '''ReceivedFrameVlanTaggingOperTable
  Filter Outer: Priority 15, VID 4096, TPID 0x8100
  Filter Inner: Priority 15, VID 4096, TPID 0x8100
  Treatment Outer: Priority 15, VID 0, TPID 0x8100
  Treatment Inner: Priority 0, VID 500, TPID 0x8100
  Filter Outer: Priority 15, VID 4096, TPID 0x8100
  Filter Inner: Priority 8, VID 600, TPID 0x8100
  Treatment Outer: Priority 15, VID 0, TPID 0x8100
  Treatment Inner: Priority 8, VID 4096, TPID 0x8100'''

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
        'me171': me(171, 'ExtVlanTagOperCfgData', [([('EntityId', '0x101'), ('AssociationType', '10'), ('AssociatedMePoint', '0x1'),
                                                     ('InputTPID', '0x8100'), ('OutputTPID', '0x8100'), ('DsMode', '0')], RULES)]),
    },
    'quick_get': lambda: {
        'pon': {'sn': 'DLKI12345678', 'ploam': '0123456789', 'loid': '', 'loid_pw': ''},
        'wifi': [{'radio': 0, 'band': '5g', 'ssid': 'NijikaWrt 5GHz', 'key': 'nijika-sample', 'enabled': True},
                 {'radio': 1, 'band': '2g', 'ssid': 'NijikaWrt 2.4GHz', 'key': 'nijika-sample', 'enabled': True}],
        'voip': [{'line': 0, 'enable': True, 'addr': 'sip.example.net', 'port': '5060', 'domain': 'example.net', 'number': '0312345678',
                  'login': '0312345678', 'password': 'secret', 'display': 'Home'},
                 {'line': 1, 'enable': False, 'addr': '', 'port': '5060', 'domain': '', 'number': '', 'login': '', 'password': '', 'display': ''}],
        'wan': {'table': 'ATM_VC_TBL', 'num': 2, 'records': [
            {'ifIndex': '65536', 'ChannelMode': '2', 'vlan': '1', 'vid': '500', 'vprio': '1', 'MTU': '1492', 'pppUser': 'user@unifi', 'pppPasswd': 'secret', 'WanName': 'INTERNET'},
            {'ifIndex': '130817', 'ChannelMode': '0', 'vlan': '1', 'vid': '600', 'vprio': '0', 'MTU': '1500', 'pppUser': '', 'pppPasswd': '', 'WanName': 'IPTV'}]},
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
    if method == 'chain':
        return DATA['quick_get']()['wan'] if args.get('table') == 'ATM_VC_TBL' else {'table': args.get('table'), 'num': 0, 'records': []}
    if method == 'diag':
        return {'cmd': args.get('cmd'), 'output': 'ONU state: Operation State(O5)\n(sample output)'}
    if method in ('mib_set',):
        return {'ok': len(args.get('values', [])), 'failed': []}
    return {'ok': True, 'message': 'mock: %s %s' % (method, json.dumps(args))}


UCI = {'nijika': {
    'vendor': {'.type': 'vendor', '.name': 'vendor', '.anonymous': False, 'boa': 'shim', 'console': '1', 'inetd': '0',
               'lan_mgmt': '1', 'lan_ifname': 'br0'},
    'banner': {'.type': 'banner', '.name': 'banner', '.anonymous': False, 'animate': 'ssh', 'color': 'auto'},
    'pon': {'.type': 'pon', '.name': 'pon', '.anonymous': False, 'cache_ttl': '5'}}}


def ubus(obj, method, args):
    if obj == 'nijika':
        return [0, nijika_call(method, args)]
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
