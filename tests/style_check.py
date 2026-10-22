# SPDX-License-Identifier: GPL-2.0-only

"""Repository rules of AGENTS.md sections 7 and 8: tests/run.sh lint.

    python3 tests/style_check.py dashes    no em dash, en dash, minus sign in text files
    python3 tests/style_check.py spdx      SPDX identifier of every source file
"""
import os
import subprocess
import sys

TOP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DASHES = ('\u2014', '\u2013', '\u2212')   # em dash, en dash, minus sign
# no SPDX header: data, images, fonts, docs, test fixtures
NO_HEADER_EXT = ('.md', '.json', '.jpg', '.png', '.webp', '.svg', '.woff2', '.txt', '.tsv')
NO_HEADER = {'LICENSE', '.gitignore', '.gitattributes', '.github/CODEOWNERS',
             'package/nijika-base/files/usr/share/nijika/banner-links'}
APACHE = ('package/luci-app-nijika/', 'package/luci-theme-perfect/')


def files():
    try:
        out = subprocess.run(['git', '-C', TOP, 'ls-files', '-co', '--exclude-standard'],
                             capture_output=True, text=True, check=True).stdout
        return [f for f in out.split('\n') if f and os.path.isfile(os.path.join(TOP, f))]
    except (OSError, subprocess.CalledProcessError):
        found = []
        for root, dirs, names in os.walk(TOP):
            dirs[:] = [d for d in dirs if d not in ('.git', 'build', 'dl', 'bin', 'stock')]
            found += [os.path.relpath(os.path.join(root, n), TOP) for n in names]
        return found


def text(f):
    try:
        return open(os.path.join(TOP, f), encoding='utf-8').read()
    except (UnicodeDecodeError, OSError):
        return None


def dashes():
    bad = []
    for f in files():
        t = text(f)
        if t is None:
            continue
        for n, line in enumerate(t.split('\n'), 1):
            if any(d in line for d in DASHES):
                bad.append('%s:%d' % (f, n))
    return bad


def spdx():
    bad = []
    for f in files():
        if f in NO_HEADER or f.endswith(NO_HEADER_EXT) or f.startswith(('docs/', 'tests/fixtures/')):
            continue
        t = text(f)
        if t is None:
            continue
        want = 'SPDX-License-Identifier: ' + ('Apache-2.0' if f.startswith(APACHE) else 'GPL-2.0-only')
        if want not in '\n'.join(t.split('\n')[:6]):
            bad.append('%s (%s)' % (f, want))
    return bad


if __name__ == '__main__':
    found = {'dashes': dashes, 'spdx': spdx}[sys.argv[1]]()
    for line in found:
        print(line)
    sys.exit(1 if found else 0)
