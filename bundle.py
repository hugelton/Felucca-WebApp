#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
"""The web editor's one-file build: app/index.html with its ES modules and stylesheets inlined.

  bundle.py PAGE.html OUT.html         the page, every <link rel="stylesheet" href> and the one
                                       <script type="module" src> replaced by their contents
  bundle.py --js ENTRY.js OUT.js       the modules alone (the tests evaluate this)

No bundler, no dependency: the module graph is walked from the entry and every module becomes one
function scope, in dependency order (a cycle is an error). The sources keep to a small subset, checked here:
  import { a, b as c } from "./x.js";        one line, relative paths, named imports only
  export { a, b };                           a list (may span lines), or
  export function / async function / class / const NAME ...
Not allowed: export default, export let / var, import * / default / dynamic import(), re-exports.
An imported name is bound once (const), so a module must not reassign what it exports.
Files the page links to other than stylesheets (fonts, licence texts) stay files; make_site.py copies them.
"""
import re
import sys
from pathlib import Path

IMPORT = re.compile(r'^import\s*\{([^}]*)\}\s*from\s*"(\.{1,2}/[^"]+)";[ \t]*$', re.M)
EXPORT_LIST = re.compile(r'^export\s*\{([^}]*)\};[ \t]*$', re.M)
EXPORT_DECL = re.compile(r'^export\s+(async\s+function|function|class|const)\s+([A-Za-z_$][\w$]*)', re.M)
BAD = [(re.compile(r'^\s*export\s+default\b', re.M), "export default"),
       (re.compile(r'^\s*export\s+(let|var)\b', re.M), "export let / var"),
       (re.compile(r'^\s*export\s*\*', re.M), "export *"),
       (re.compile(r'^\s*export\s*\{[^}]*\}\s*from\b', re.M), "re-export"),
       (re.compile(r'^\s*import\s+(?!\{)', re.M), "import other than { names }"),
       (re.compile(r'\bimport\s*\('), "dynamic import()")]
IDENT = re.compile(r'^[A-Za-z_$][\w$]*$')


class BundleError(Exception):
    pass


def names_of(spec, path, what):
    out = []
    for part in spec.split(","):
        part = " ".join(part.split())
        if not part:
            continue
        m = re.fullmatch(r'([A-Za-z_$][\w$]*)(?: as ([A-Za-z_$][\w$]*))?', part)
        if not m:
            raise BundleError(f"{path}: bad {what} name {part!r}")
        out.append((m.group(1), m.group(2) or m.group(1)))
    return out


def parse(path):
    src = path.read_text(encoding="utf8")
    for rx, what in BAD:
        m = rx.search(src)
        if m:
            line = src.count("\n", 0, m.start()) + 1
            raise BundleError(f"{path}:{line}: {what} is not supported by bundle.py")
    imports = []                                       # (resolved path, [(name, local)])
    for m in IMPORT.finditer(src):
        imports.append(((path.parent / m.group(2)).resolve(), names_of(m.group(1), path, "import")))
    stray = [ln for ln in src.splitlines() if re.match(r'\s*import\b(?!\s*:)', ln) and not IMPORT.match(ln)]   # (not a key "import:")
    if stray:
        raise BundleError(f"{path}: import not on one line: {stray[0].strip()!r}")
    exports = []
    for m in EXPORT_LIST.finditer(src):
        exports += names_of(m.group(1), path, "export")
    exports += [(m.group(2), m.group(2)) for m in EXPORT_DECL.finditer(src)]
    if re.search(r'^\s*export\b', EXPORT_DECL.sub("", EXPORT_LIST.sub("", src)), re.M):
        raise BundleError(f"{path}: an export bundle.py does not read")
    body = IMPORT.sub("", src)
    body = EXPORT_LIST.sub("", body)
    body = EXPORT_DECL.sub(lambda m: m.group(1) + " " + m.group(2), body)
    # exports: (local, exported as)
    return {"imports": imports, "exports": exports, "body": body}


def graph(entry):
    entry = Path(entry).resolve()
    mods, order, state = {}, [], {}

    def visit(p, chain):
        if state.get(p) == "done":
            return
        if state.get(p) == "open":
            raise BundleError("import cycle: " + " -> ".join(x.name for x in chain + [p]))
        if not p.exists():
            raise BundleError(f"missing module {p} (from {chain[-1] if chain else 'entry'})")
        state[p] = "open"
        mods[p] = parse(p)
        for dep, _ in mods[p]["imports"]:
            visit(dep, chain + [p])
        state[p] = "done"
        order.append(p)

    visit(entry, [])
    for p in order:                                    # every imported name is exported by its module
        for dep, names in mods[p]["imports"]:
            have = {as_ for _, as_ in mods[dep]["exports"]}
            for name, _ in names:
                if name not in have:
                    raise BundleError(f"{p.name}: {dep.name} does not export {name}")
    return order, mods


def bundle_js(entry, expose=False):
    """the modules as one script; expose: the entry's exports become the script's completion value"""
    order, mods = graph(entry)
    ids = {p: f"__m{i}" for i, p in enumerate(order)}
    root = Path(entry).resolve().parent
    out = []
    for p in order:
        m = mods[p]
        rel = p.relative_to(root) if p.is_relative_to(root) else p.name
        binds = "".join(
            f"  const {{ {', '.join(n if n == l else f'{n}: {l}' for n, l in names)} }} = {ids[dep]};\n"
            for dep, names in m["imports"])
        ret = ", ".join(l if l == a else f"{a}: {l}" for l, a in m["exports"])
        out.append(f"/* ---- {rel} ---- */\nconst {ids[p]} = (() => {{\n{binds}{m['body'].rstrip()}\n"
                   f"  return {{ {ret} }};\n}})();\n")
    if expose:
        out.append(f"{ids[order[-1]]};\n")
    return '"use strict";\n' + "".join(out)


LINK = re.compile(r'<link\s+rel="stylesheet"\s+href="([^"]+)"\s*>')
SCRIPT = re.compile(r'<script\s+type="module"\s+src="([^"]+)"\s*>\s*</script>')


def bundle_page(page):
    page = Path(page)
    html = page.read_text(encoding="utf8")
    html = LINK.sub(lambda m: "<style>\n" + (page.parent / m.group(1)).read_text(encoding="utf8").rstrip() + "\n</style>", html)
    scripts = SCRIPT.findall(html)
    if len(scripts) != 1:
        raise BundleError(f"{page}: expected one <script type=\"module\" src>, found {len(scripts)}")
    js = bundle_js(page.parent / scripts[0]).replace("</script", "<\\/script")
    return SCRIPT.sub(lambda m: "<script type=\"module\">\n" + js + "</script>", html)


def main():
    a = sys.argv[1:]
    try:
        if len(a) == 3 and a[0] == "--js":
            Path(a[2]).write_text(bundle_js(a[1], expose=True), encoding="utf8")
        elif len(a) == 2:
            Path(a[1]).write_text(bundle_page(a[0]), encoding="utf8")
        else:
            raise SystemExit(__doc__)
    except BundleError as e:
        raise SystemExit(f"bundle.py: {e}")


if __name__ == "__main__":
    main()
