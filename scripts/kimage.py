#!/usr/bin/env python3
"""Unpack the stock kernel: kimage.py KIMAGE OUTDIR -> OUTDIR/Image, OUTDIR/config

The stock kimage (a FIT image) carries an LZMA (or gzip) compressed arm64
Image; CONFIG_IKCONFIG puts the kernel's .config into it (gzip between the
IKCFG_ST/IKCFG_ED markers).
"""
import lzma
import os
import sys
import zlib

kimage, out = sys.argv[1], sys.argv[2]
data = open(kimage, 'rb').read()


def unpack(blob):
    for magic, fn in ((b'\x5d\x00\x00', lambda b: lzma.LZMADecompressor().decompress(b)),
                      (b'\x1f\x8b\x08', lambda b: zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(b))):
        i = blob.find(magic)
        while i != -1:
            try:
                img = fn(blob[i:])
                if len(img) > 1 << 20 and b'IKCFG_ST' in img:
                    return img
            except (lzma.LZMAError, zlib.error, EOFError):
                pass
            i = blob.find(magic, i + 1)
    return None


img = data if b'IKCFG_ST' in data else unpack(data)
if img is None:
    sys.exit('kimage.py: no kernel Image with IKCONFIG in %s' % kimage)
i = img.index(b'IKCFG_ST') + 8
cfg = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(img[i:])
os.makedirs(out, exist_ok=True)
open(os.path.join(out, 'Image'), 'wb').write(img)
open(os.path.join(out, 'config'), 'wb').write(cfg)
first = [l for l in cfg.decode(errors='replace').splitlines() if 'Kernel Configuration' in l]
sys.stderr.write('kimage.py: Image %d bytes, %s\n' % (len(img), first[0].strip('# ') if first else 'config'))
