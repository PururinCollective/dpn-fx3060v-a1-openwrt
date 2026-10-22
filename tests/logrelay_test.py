# SPDX-License-Identifier: GPL-2.0-only

"""logrelay filter test: tests/run.sh helpers.

    python3 tests/logrelay_test.py <logrelay-binary> <short-temp-dir>

Starts the relay between two Unix datagram sockets in the temp dir (keep
the path short: sun_path holds 108 bytes), sends syslog lines of several
priorities and prints what came out, one message text per line.
"""
import os
import socket
import subprocess
import sys
import time

relay, d = sys.argv[1], sys.argv[2]
inp, out = os.path.join(d, 'in.sock'), os.path.join(d, 'out.sock')
rx = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
rx.bind(out)
rx.settimeout(0.5)
proc = subprocess.Popen([relay, inp, out, '5'])
try:
    for _ in range(100):
        if os.path.exists(inp):
            break
        time.sleep(0.02)
    tx = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    for m in (b'<14>Oct 14 21:19:18 VoIP_maserati: user.info',
              b'<13>Oct 14 21:19:18 cwmpClient: user.notice',
              b'<11>Oct 14 21:19:18 spppd: user.err',
              b'<191>Oct 14 21:19:18 x: local7.debug',
              b'<133>Oct 14 21:19:18 x: local0.notice',
              b'no header'):
        tx.sendto(m, inp)
    while True:
        try:
            print(rx.recv(9000).split(b': ', 1)[-1].decode())
        except socket.timeout:
            break
finally:
    proc.terminate()
    proc.wait()
