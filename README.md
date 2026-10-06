# Felucca Web App

The web pages for [Felucca](https://github.com/hugelton/Felucca), custom firmware that runs on the M-VAVE FM-1:
the installer and the editor. They talk to the device over Web MIDI (SysEx) and run in the browser; nothing is
sent to a server. The site is published at https://hugelton.github.io/Felucca/.

- `app/` — the editor: ES modules, built into one page by `bundle.py`. `app/index.html?mock=1` runs it against
  a simulated device.
- `editor.html` — the current editor, kept while the new one replaces it.
- `index_pkg.html`, `fm1pkg.js`, `fm1ota.js`, `fm1backup.js` — the installer, the update protocol and the full backup.
- `make_site.py` — builds the site from these pages and a firmware release.

## Working on it

```sh
python3 serve.py            # http://localhost:8766/app/index.html?mock=1
node test_app.mjs           # the new editor: device layer, build, tokens, words, icons
node test_web.mjs           # the protocol, samples, packages, the updater (FELUCCA_PROTO=app: the new modules)
node test_backup.mjs        # the full backup
```

Checks that compare with the firmware use files from a Felucca checkout, passed in by environment variables:
`FELUCCA_DESC` (the parameter tables, `desc.json`), `FELUCCA_TOOLS` (its `tools/`), `FELUCCA_ROOT` (a firmware
build), `FELUCCA_PALETTES` (`tools/gen_ui_palettes.py`), `FELUCCA_INTERTIGHT` (`assets/fonts/InterTight[wght].ttf`).
Without them those checks are skipped.

The editor protocol is described in the firmware repository (`web/EDITOR_PROTOCOL.md`).

## Licence

GPL-3.0-only (`LICENSE`), Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments.
Bundled: Inter Tight (SIL OFL 1.1), Fukiai icons (MIT), and the FM algorithm tables of msfa (Apache-2.0);
see `LICENSING.md` and `LICENSES/`.

M-VAVE and FM-1 are trademarks of their respective owners. This project is not affiliated with or endorsed by them.
