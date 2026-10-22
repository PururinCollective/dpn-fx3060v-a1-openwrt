#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only

"""Exported symbol names of a raw (decompressed) arm64 kernel Image.

    ksymtab.py IMAGE > vmlinux.symvers

arm64 5.10 keeps EXPORT_SYMBOL*() as __ksymtab / __ksymtab_gpl entries of
three 32-bit offsets relative to themselves (value, name, namespace;
CONFIG_HAVE_ARCH_PREL32_RELOCATIONS), followed by __ksymtab_strings. The
string section is found as the longest run of NUL-terminated identifiers
(its strings are tail-merged: "printk" is the end of "vprintk", so the
names come from the entries, walked backwards from the strings until an
entry no longer points into them). Checked against exports every 5.10
kernel has. Output: a Module.symvers for modpost, without CRCs (the stock
kernel has no MODVERSIONS), so building a module that needs a symbol the
stock kernel does not export fails at build time instead of at insmod.
"""
import re
import struct
import sys

MUST = ('printk', 'kmalloc_caches', '__stack_chk_fail', 'register_netdevice', 'sk_alloc', 'skb_put')

data = open(sys.argv[1], 'rb').read()

# __ksymtab_strings: the longest identifier run, starting 4-byte aligned
best = (0, 0)
for m in re.finditer(rb'(?:[A-Za-z_][A-Za-z0-9_.]{1,127}\x00){500,}', data):
    if m.end() - m.start() > best[1] - best[0]:
        best = (m.start(), m.end())
s_start, s_end = best
# the empty namespace string(s) may sit right before the run
while s_start > 0 and data[s_start - 1] == 0 and s_start % 4:
    s_start -= 1
s_start -= s_start % 4

def name_at(off):
    if not (s_start <= off < s_end):
        return None
    end = data.index(b'\x00', off)
    n = data[off:end]
    return n.decode() if re.fullmatch(rb'[A-Za-z_][A-Za-z0-9_.]*', n) else None

def entry(e):
    """(name, namespace address) of the entry at e, or None"""
    _, name_off, ns_off = struct.unpack_from('<iii', data, e)
    n = name_at(e + 4 + name_off)
    if ns_off == 0:		# assembler exports (asm-generic/export.h): no namespace
        return (n, 0) if n is not None else None
    ns = e + 8 + ns_off
    return (n, ns) if n is not None and s_start <= ns < s_end else None

# Walk back from the strings: __ksymtab_gpl, then __ksymtab (and the
# unused/future ones), with alignment padding between the sections. Symbols
# without a namespace all point at the same empty string, which tells real
# entries after padding from chance matches.
names = []
e = s_start - 12
first = entry(e)
if first is None:
    sys.exit('ksymtab.py: no __ksymtab entry before the strings at 0x%x' % s_start)
no_ns = first[1]
while e >= 0:
    ent = entry(e)
    if ent is None:
        for pad in range(4, 33, 4):
            ent = entry(e - pad)
            if ent is not None and ent[1] in (no_ns, 0):
                e -= pad
                break
        else:
            break
    names.append(ent[0])
    e -= 12

have = set(names)
missing = [n for n in MUST if n not in have]
if missing:
    sys.exit('ksymtab.py: no export table found (missing %s)' % ', '.join(missing))
for n in sorted(have):
    # EXPORT_SYMBOL_GPL vs EXPORT_SYMBOL is not recorded; the modules built
    # here are GPL, which may use both
    sys.stdout.write('0x00000000\t%s\tvmlinux\tEXPORT_SYMBOL_GPL\t\n' % n)
sys.stderr.write('ksymtab.py: %d exported symbols\n' % len(have))
