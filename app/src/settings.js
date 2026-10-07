// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// Settings: the device's globals (BPM, swing, tune, MIDI IN), its display preferences (theme, font, MIDI monitor),
// its MENU settings (1.0.4: LEDS .. USB SERIAL, as the device lists them),
// the editor's own (display, text size, language: kept in this browser) and what the device reported.

import { el, store } from "./dom.js";
import { G_SKIP, HEAD_IC, LAYOUT, paramIcon, placedGlobals, visible } from "./layout.js";
import { card, cells, paramRow } from "./parts.js";
import { MENU_ICON } from "./paramicons.js";
import { knownLayout } from "./device.js";
import { LANGS, getLang, setLang, t } from "./text.js";

/* the site has the emulator beside the editor (make_site.py --try) */
const TRY = !!(globalThis.document && (document.querySelector('meta[name="felucca-try"]') || {}).content);
export const THEMES = ["system", "dark", "light"];
export const SIZES = [1, 1.25, 1.5];
export function applyEditorPrefs() {
  const th = store.get("felucca-editor-theme", "system"), k = +store.get("felucca-editor-size", "1");
  if (th === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = th;
  document.documentElement.style.setProperty("--k", SIZES.includes(k) ? k : 1);
  document.documentElement.lang = getLang();
}

export function settingsScreen(root, ui) {
  const rows = new Map(), menuRows = new Map();
  let dev = null;

  function globals() {
    const g = LAYOUT(dev.info.pe0).find((x) => x.place === "settings");
    /* the layout's order first; then any global no page places (one a newer firmware adds) */
    const placed = placedGlobals(dev.info.pe0);
    const ids = knownLayout(dev.info) ? [...g.pages.flatMap(([, , list]) => list), ...dev.gdesc.map((_, i) => i).filter((i) => !placed.has(i))]
      : dev.gdesc.map((_, i) => i);
    const out = [];
    for (const id of ids) {
      const d = dev.gdesc[id];
      if (!visible(d) || G_SKIP.has(d.label)) continue;
      const r = paramRow(d, dev.dump.g[id], (v) => { dev.setParam(1, id, v); ui.changed(1, id, v); }, { icon: (v) => paramIcon(d, v) });
      rows.set(id, r); out.push(r.el);
    }
    return card(t("global"), HEAD_IC.GLOBAL, el("div", { class: "rows" }, ...out));
  }

  function display() {
    const p = dev.preferences;
    if (!p || !(p.state.caps & 7)) return null;
    const defs = [[0, t("theme"), p.palettes, p.state.palette], [1, t("font"), [t("regular"), t("bold")], p.state.font],
      [2, t("monitor"), [t("off"), t("events"), t("notes")], p.state.monitor]];
    const out = [];
    for (const [id, label, names, v] of defs) {
      if (!(p.state.caps & (1 << id))) continue;
      const d = { fmt: 8, min: 0, max: names.length - 1, def: 0, label, unit: "", names };
      out.push(paramRow(d, v, async (nv) => { const rc = await dev.changePreference(id, nv); ui.prefResult(rc); }).el);
    }
    return card(t("device"), "port_usb_c", el("div", { class: "rows" }, ...out));
  }

  /* the device's MENU (its order, its names); COLOR when the display card does not already show the theme */
  function menu() {
    const items = (dev.menu || []).filter((m) => !(m.id === 0 && dev.preferences && dev.preferences.state.caps & 1));
    if (!items.length) return null;
    const out = items.map((m) => {
      const d = m.kind === 0 ? { fmt: 8, min: m.min, max: m.max, def: m.min, label: m.name, unit: "", names: m.names }
        : { fmt: 0, min: m.min, max: m.max, def: m.min, label: m.name, unit: m.unit, names: [] };
      const r = paramRow(d, m.value, async (v) => {
        if (m.name === "USB SERIAL" && v !== m.value && !(await ui.confirm(t("usbQ")))) { r.update(m.value, false); return; }
        ui.prefResult(await dev.menuSet(m.id, v));
      }, { icon: MENU_ICON[m.name] || "symbol_cog" });
      menuRows.set(m.id, r);
      return r.el;
    });
    return card("MENU", "control_menu_lines", el("div", { class: "rows" }, ...out));
  }

  function editor() {
    const th = THEMES.indexOf(store.get("felucca-editor-theme", "system"));
    const k = SIZES.indexOf(+store.get("felucca-editor-size", "1"));
    const field = (label, c) => el("div", { class: "enum" }, el("span", { class: "lbl", text: label }), c.el);
    return card(t("editor"), "symbol_eye",
      field(t("display"), cells([t("system_"), t("dark"), t("light")], Math.max(0, th), (i) => { store.set("felucca-editor-theme", THEMES[i]); applyEditorPrefs(); }, t("display"))),
      field(t("textSize"), cells(["1×", "1.25×", "1.5×"], Math.max(0, k), (i) => { store.set("felucca-editor-size", String(SIZES[i])); applyEditorPrefs(); }, t("textSize"))),
      field(t("language"), cells(["ENGLISH", "日本語"], LANGS.indexOf(getLang()), (i) => { setLang(LANGS[i]); ui.relabel(); }, t("language"))));
  }

  function system() {
    const i = dev && dev.info;
    const kv = (k, v) => [el("dt", { text: k }), el("dd", { text: v })];
    return card(t("system"), "symbol_info_o",
      el("dl", { class: "kv" }, ...(i ? [
        ...kv(t("firmware"), i.version), ...kv(t("sync"), dev.watch ? t("live") : t("polling")),
        ...kv(t("engines"), String(i.engines.filter((x) => x !== "-").length)), ...kv(t("tracks"), String(i.ntrk || 1)),
        ...kv(t("stepsN"), String(i.nstep)),
        ...kv(t("samples"), dev.smp ? `${dev.smp.nslots} × ${dev.smp.slotKiB} KiB` : "—"),
        ...kv(t("userBank"), dev.bank ? String(dev.bank.total) : "—")] : [])),
      el("div", { class: "links" },
        el("a", { class: "btn", href: "../installer/", text: t("installer") }),
        TRY ? el("a", { class: "btn", href: "../try/", text: t("tryIt") }) : null,
        el("a", { class: "btn", href: "../editor-classic/", text: t("classic") }),
        el("a", { class: "btn", href: "fonts/OFL.txt", text: "Inter Tight · OFL" }),
        el("a", { class: "btn", href: "fonts/FUKIAI-LICENSE.txt", text: "Fukiai · MIT" })),
      /* the one note the page carries: what it runs on, and whose names those are */
      el("p", { class: "note", text: "Runs on M-VAVE FM-1. M-VAVE and FM-1 are trademarks of their respective owners; this project is not affiliated with them." }));
  }

  return {
    show(device) {
      dev = device;
      rows.clear(); menuRows.clear();
      const grid = el("div", { class: "grid" });
      if (dev && dev.dump) grid.append(globals());
      const disp = dev && dev.dump ? display() : null;
      if (disp) grid.append(disp);
      const mn = dev && dev.dump ? menu() : null;
      if (mn) grid.append(mn);
      grid.append(editor(), system());
      root.replaceChildren(grid);
    },
    param(s, id, v) { if (s === 1 && rows.has(id)) rows.get(id).update(v); },
    /* the MENU read again (settings opened, a value set): the shown rows follow */
    menu(items) { for (const m of items || []) if (menuRows.has(m.id)) menuRows.get(m.id).update(m.value, false); },
  };
}
