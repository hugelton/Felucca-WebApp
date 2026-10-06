#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
"""The web app's text face: Inter Tight (SIL OFL 1.1) cut to the Latin the page uses.

  gen_fonts.py [--source PATH] [--check]

PATH: the variable font InterTight[wght].ttf (default: ../assets/fonts/ next to this file, or
FELUCCA_INTERTIGHT). Writes app/fonts/InterTight-subset.ttf, all weights kept (the variable axis), with
kerning, tabular figures, case forms and ligatures. The OFL travels with it (app/fonts/OFL.txt).
--check compares the file with what this would write.
"""
import io
import os
import sys
from pathlib import Path

from fontTools import subset

HERE = Path(__file__).resolve().parent
OUT = HERE / "app" / "fonts" / "InterTight-subset.ttf"
UNICODES = "U+0020-007E,U+00A0-00FF,U+2013,U+2014,U+2018-201D,U+2022,U+2026,U+2190-2193,U+2212,U+2264,U+2265,U+00D7"
FEATURES = ["kern", "tnum", "case", "calt", "liga"]


def build(src):
    opts = subset.Options()
    opts.layout_features = FEATURES
    font = subset.load_font(str(src), opts)
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=subset.parse_unicodes(UNICODES))
    sub.subset(font)
    buf = io.BytesIO()
    subset.save_font(font, buf, opts)
    return buf.getvalue()


def main():
    a = sys.argv[1:]
    src = a[a.index("--source") + 1] if "--source" in a else os.environ.get("FELUCCA_INTERTIGHT") or \
        str(HERE.parent / "assets" / "fonts" / "InterTight[wght].ttf")
    if not Path(src).exists():
        raise SystemExit(f"gen_fonts.py: no font at {src} (pass --source PATH to InterTight[wght].ttf)")
    data = build(src)
    if "--check" in a:
        if not OUT.exists() or OUT.read_bytes() != data:
            raise SystemExit(f"{OUT} is stale: run gen_fonts.py")
        return
    OUT.write_bytes(data)


if __name__ == "__main__":
    main()
