#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
"""Make the public site (the hugelton/Felucca repository, GitHub Pages from main):

  index.html                  redirect to the installer (the old URL keeps working)
  firmware/felucca-VER.fwsc   the package (+ LICENSE, LICENSING.md, LICENSES/: the package holds
                              JieLi SDK files under Apache-2.0, see LICENSING.md)
  webapp/installer/index.html index_pkg.html, self-contained (fm1pkg.js, fm1ota.js, fm1backup.js, the
                              metadata and the editor's colour tokens inlined; its font is the editor's)
  webapp/editor/index.html    the editor (app/): its modules and stylesheets in one page (bundle.py),
                              its fonts and their licences in fonts/
  webapp/editor-classic/      the earlier editor (editor.html + fukiai.ttf, FUKIAI-LICENSE.txt, fm1backup.js)
  webapp/try/                 with --try DIR: the emulator (DIR as it is: index.html, worklet.js, felucca.wasm, fonts/ ... from the firmware's
                              release), linked from the installer and the editor; without it: left as it is.
                              --next: the emulator is a preview of the next version (the links say so)
  src/                        not touched (Felucca's sources go there)

  make_site.py PACKAGE.fwsc VERSION OUT_DIR [--licences DIR] [--try DIR [--next]]

DIR: the firmware release's licence files, the ones that travel with the package: LICENSE,
LICENSING.md and LICENSES/*.txt, and ATTRIBUTION.txt when the release has one (default: FELUCCA_LICENCES, else the folder above this one when it
holds them, as in a Felucca checkout). They are checked before anything is written. (This repository's
own LICENSES are the web app's, not the package's.)

The package must be one made by tools/fm1pkg_make.py (Felucca's own loader, no vendor files).
Its identity (FM-1_9xx) is read from the package; the device must report it after
the install.
"""
import json
import os
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from bundle import bundle_page  # noqa: E402
BLOCKS, BLK, KEEP = 20, 0x30, 0x2F


def strip_module(src):
    src = re.sub(r"^export\s+", "", src, flags=re.M)
    return re.sub(r"^import .*?;\n", "", src, flags=re.M)


def product_of(raw):
    """the package identity: one marker byte after each of the first 20 blocks (fm1pkg.js productOf)"""
    return "".join(chr((m - i - 1) & 0xFF) for i in range(BLOCKS) if (m := raw[i * BLK + KEEP]) != 0x7D)


def licences_dir(arg=None):
    """the firmware's licence files: --licences, FELUCCA_LICENCES, or the folder above (a Felucca checkout)"""
    cands = [Path(arg)] if arg else [Path(os.environ["FELUCCA_LICENCES"])] if os.environ.get("FELUCCA_LICENCES") else [HERE.parent]
    for d in cands:
        if (d / "LICENSE").is_file() and (d / "LICENSING.md").is_file() and list((d / "LICENSES").glob("*.txt")):
            return d.resolve()
    raise SystemExit(f"make_site.py: no firmware licence files (LICENSE, LICENSING.md, LICENSES/*.txt) in {cands[0]}; "
                     "pass --licences DIR (the firmware release's)")


TRY_FILES = ("index.html", "worklet.js", "felucca.wasm")


def sample_pack_in(licensing):
    """the package carries the Sample Pack (1.0.3.x): LICENSING.md's row for it does not say it is not in the firmware"""
    rows = [x for x in licensing.splitlines() if "Sample Pack" in x]
    return any("not in the firmware" not in x.lower() for x in rows)


def main(pkg, version, out, licences=None, try_dir=None, next_=False):
    pkg, out = Path(pkg), Path(out)
    lic_root = licences_dir(licences)                # (before anything is written)
    if try_dir and not all((Path(try_dir) / f).is_file() for f in TRY_FILES):
        raise SystemExit(f"make_site.py: --try {try_dir}: needs {', '.join(TRY_FILES)}")
    raw = pkg.read_bytes()
    product = product_of(raw)
    if not re.fullmatch(r"FM-1_9\d\d", product):
        raise SystemExit(f"{pkg}: identity {product!r} is not a Felucca package (FM-1_9xx)")
    if b"FELUCCA-LOADER-1" not in raw:              # Felucca loader marker: never publish a package with vendor files
        raise SystemExit(f"{pkg}: no Felucca loader in it; the site ships only fm1pkg_make.py packages "
                         "(a package patched from an official one carries vendor files)")
    html = (HERE / "index_pkg.html").read_text(encoding="utf-8")
    lib = strip_module((HERE / "fm1pkg.js").read_text(encoding="utf-8")) + "\n" + \
        strip_module((HERE / "fm1ota.js").read_text(encoding="utf-8")) + "\n" + \
        strip_module((HERE / "fm1backup.js").read_text(encoding="utf-8"))
    name = f"felucca-{re.sub(r'[^A-Za-z0-9.-]', '-', version)}.fwsc"
    meta = json.dumps({"version": version, "product": product, "pkg": "../../firmware/" + name})
    for mark in ("/*LIB*/", "/*META*/", "/*TOKENS*/"):
        if html.count(mark) != 1:
            raise SystemExit(f"index_pkg.html must contain {mark} once; update make_site.py")
    tokens = (HERE / "app" / "tokens.css").read_text(encoding="utf-8")   # the editor's colours (gen_tokens.py)
    html = html.replace("/*LIB*/", lib).replace("/*META*/", meta).replace("/*TOKENS*/", tokens)
    credit = "drum voices and Fukiai icons (MIT)"        # (a package with the Sample Pack, 1.0.3.x: its credit too)
    if html.count(credit) != 1:
        raise SystemExit("index_pkg.html: the credits line changed; update make_site.py")
    if sample_pack_in((lic_root / "LICENSING.md").read_text(encoding="utf-8")):
        html = html.replace(credit, "drum voices, Sample Pack and Fukiai icons (MIT)")
    inst, ed, cl, fw = out / "webapp" / "installer", out / "webapp" / "editor", out / "webapp" / "editor-classic", out / "firmware"
    editor = bundle_page(HERE / "app" / "index.html")   # (before anything is written: a module the bundler refuses stops here)
    rel = '<meta name="felucca-release" content="">'
    if editor.count(rel) != 1:
        raise SystemExit("app/index.html must have the felucca-release meta once; update make_site.py")
    editor = editor.replace(rel, f'<meta name="felucca-release" content="{re.sub(r"[^0-9A-Za-z.-]", "", version)}">')   # (its update notice)
    for d in (inst, ed, cl, fw):
        d.mkdir(parents=True, exist_ok=True)
    for old in fw.glob("felucca-*.fwsc"):          # one package: the current one
        old.unlink()
    has_try = bool(try_dir) or (out / "webapp" / "try" / "index.html").is_file()   # (one already there stays linked)
    if has_try:
        link = '<p id="next-p" hidden>' if next_ else '<p id="try-p" hidden>'
        if html.count(link) != 1 or editor.count('<meta name="felucca-try" content="">') != 1:
            raise SystemExit("index_pkg.html / app/index.html: the try link or meta changed; update make_site.py")
        html = html.replace(link, link.replace(" hidden", ""))
        editor = editor.replace('<meta name="felucca-try" content="">', f'<meta name="felucca-try" content="{"next" if next_ else "1"}">')
    if try_dir:                                      # the whole folder (its fonts/ too); what an earlier one had goes
        shutil.rmtree(out / "webapp" / "try", ignore_errors=True)
        shutil.copytree(Path(try_dir), out / "webapp" / "try")
    (inst / "index.html").write_text(html, encoding="utf-8")
    shutil.copy(pkg, fw / name)
    lic = lic_root / "LICENSES"                     # the package holds JieLi SDK files (Apache-2.0): their
    (fw / "LICENSES").mkdir(exist_ok=True)          # licence travels next to it, with Felucca's own
    names = sorted(f.name for f in lic.glob("*.txt"))
    for n in names:
        shutil.copy(lic / n, fw / "LICENSES" / n)
    (fw / "LICENSES" / "index.html").write_text(    # the installer links this folder: Pages lists no folders
        '<!doctype html><meta charset="utf-8"><title>Felucca licences</title><h1>Licence texts</h1><ul>'
        + "".join(f'<li><a href="{n}">{n}</a></li>' for n in names)
        + '</ul><p><a href="../LICENSING.md">LICENSING.md</a> · <a href="../LICENSE">LICENSE (GPL-3.0)</a></p>\n',
        encoding="utf-8")
    for doc in ("LICENSE", "LICENSING.md"):
        shutil.copy(lic_root / doc, fw / doc)
    if (lic_root / "ATTRIBUTION.txt").is_file():     # (the CC0 samples' sources, 1.0.4 on)
        shutil.copy(lic_root / "ATTRIBUTION.txt", fw / "ATTRIBUTION.txt")
    else:
        (fw / "ATTRIBUTION.txt").unlink(missing_ok=True)
    (ed / "index.html").write_text(editor, encoding="utf-8")
    for f in ("fukiai.ttf", "FUKIAI-LICENSE.txt", "fm1backup.js"):   # (the earlier editor's, now in editor-classic/)
        (ed / f).unlink(missing_ok=True)
    shutil.rmtree(ed / "fonts", ignore_errors=True)
    (ed / "fonts").mkdir()
    for f in sorted((HERE / "app" / "fonts").iterdir()):   # (links in the source: their files)
        shutil.copyfile(f.resolve(), ed / "fonts" / f.name)
    shutil.copy(HERE / "editor.html", cl / "index.html")
    for f in ("fukiai.ttf", "FUKIAI-LICENSE.txt", "fm1backup.js"):
        if (HERE / f).exists():
            shutil.copy(HERE / f, cl / f)
    (out / "index.html").write_text(
        '<!doctype html><meta charset="utf-8"><title>Felucca</title>'
        '<meta http-equiv="refresh" content="0; url=webapp/installer/">'
        '<a href="webapp/installer/">Felucca installer</a>\n', encoding="utf-8")
    print(f"site: {out}: webapp/installer ({len(html)} B), webapp/editor ({len(editor)} B), webapp/editor-classic, "
          f"firmware/{name} ({len(raw)} B, {product})")


if __name__ == "__main__":
    a = sys.argv[1:]
    nx = "--next" in a
    if nx:
        a.remove("--next")
    lic = None
    if "--licences" in a:
        k = a.index("--licences")
        if k + 1 >= len(a):
            sys.exit(__doc__)
        lic = a[k + 1]
        del a[k:k + 2]
    tr = None
    if "--try" in a:
        k = a.index("--try")
        if k + 1 >= len(a):
            sys.exit(__doc__)
        tr = a[k + 1]
        del a[k:k + 2]
    if len(a) != 3:
        sys.exit(__doc__)
    main(*a, licences=lic, try_dir=tr, next_=nx)
