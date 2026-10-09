// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// SOUND: the selected track's voice (engine, preset, init) and its parameters, grouped as on the device (layout.js),
// with the envelope and the LFO drawn from their values. Built when the sound's engine or DESC changes; values
// change in place (a row the user holds is left alone).

import { F, aliasOf, engineOrder } from "./proto.js";
import { ENGINE_IC, el, ic, store } from "./dom.js";
import { fm6Screen } from "./fm6.js";
import { G_SKIP, HEAD_IC, LAYOUT, paramIcon, visible } from "./layout.js";
import { card, cells, paramRow } from "./parts.js";
import { knownLayout } from "./device.js";
import { getLang, t } from "./text.js";

const NS = "http://www.w3.org/2000/svg";
const svg = (tag, a = {}) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); return e; };
const key = (s, id) => s + ":" + id;

export function soundScreen(root, ui) {
  const rows = new Map();                           /* "s:id" -> part */
  const pageOf = new Map();                         /* group title -> page shown */
  let dev = null, built = "", viz = {};

  const value = (s, id) => (s ? dev.dump.g[id] : dev.dump.p[id]);
  const desc = (s, id) => (s ? dev.gdesc[id] : dev.pdesc[id]);
  /* a matrix destination E1..E8 by the engine's label of that parameter (as the device shows it) */
  const modDst = (d) => (d && /^DST\d$/.test(d.label) ? (x) => {
    const m = /^E([1-8])$/.exec(x), e = m && dev.pdesc[dev.info.pe0 + +m[1] - 1];
    return e && visible(e) ? e.label : x;
  } : null);

  const engineAt = (k) => { const id = dev.info.pe0 + k, e = dev.pdesc[id]; return visible(e) ? { desc: e, value: dev.dump.p[id] } : null; };
  /* FM6's SLOT as the device shows it: F1..F8, OWN, (1.4.1) B1..B32 with the bank's voice names */
  const fm6Slot = (s, id) => (!s && dev.engineName() === "FM6" && id === dev.info.pe0 + 7 && dev.pdesc[id] && dev.pdesc[id].label === "SLOT" ? (x) => {
    const v = +x, b = dev.fm6bank, nf = dev.info.fm6 ? dev.info.fm6.factory || 8 : 8;
    if (!Number.isInteger(v)) return x;
    if (v < nf) return `F${v + 1}`;
    if (v === nf) return "OWN";
    const k = v - nf - 1, voice = b && b.voices && b.voices[k];
    return `B${k + 1}` + (voice && voice.used ? ` ${voice.name}` : "");
  } : null);
  /* 1.5 (P_E0 >= 103): the INSERT's A B C named and shown by its TYPE (96), as the device's ins_desc; ATK DEC REL as
     note values while ENV SYNC (102) is ON (DESC keeps the plain TIME) */
  const v15 = () => dev.info.pe0 >= 103;
  const insType = () => { const d = dev.pdesc[96]; return d && d.names ? d.names[dev.dump.p[96] - d.min] || "OFF" : "OFF"; };
  const CRUSH_RATE = ["689", "919", "1.1k", "1.4k", "1.8k", "2.2k", "2.8k", "3.7k", "4.4k", "5.5k", "7.4k", "8.8k", "11k", "15k", "22k", "44k"];
  function insView(id, d) {
    const ty = insType(), k = id - 97;
    if (["SOFT", "HARD", "FOLD", "FUZZ"].includes(ty)) return [{ ...d, label: "DRIVE" }, { ...d, label: "TONE", fmt: F.CUTOFF }, { ...d, label: "LEVEL", fmt: F.DB }][k];
    if (ty === "CRUSH") return [{ ...d, label: "BITS", fmt: F.INT, rename: (x) => String(1 + (+x >> 3)) },
      { ...d, label: "RATE", fmt: F.INT, unit: "Hz", rename: (x) => CRUSH_RATE[Math.max(0, Math.min(15, +x >> 3))] }, { ...d, label: "LPF", fmt: F.CUTOFF }][k];
    if (["PHASR", "FLANG", "CHOR"].includes(ty)) return [{ ...d, label: "RATE", fmt: F.LFOHZ }, { ...d, label: "DEPTH" }, { ...d, label: "FDBK" }][k];
    return d;
  }
  const ESYNC_NAMES = ["0", "1/64T", "1/64", "1/32T", "1/64D", "1/32", "1/16T", "1/32D", "1/16", "1/8T", "1/16D",
    "1/8", "1/4T", "1/8D", "1/4", "1/2T", "1/4D", "1/2", "1/1T", "1/2D", "1/1", "1/1D", "2BAR", "3BAR", "4BAR"];
  const esyncStep = (v) => Math.floor((v & 127) * 25 / 128), esyncValue = (k) => Math.floor((k * 128 + 24) / 25);
  const esync = (s, id) => !s && v15() && [1, 2, 4].includes(id) && !!dev.dump.p[102];
  function row(s, id) {
    let d = desc(s, id);
    if (!visible(d) || (s === 1 && G_SKIP.has(d.label))) return null;
    let rename = modDst(d) || fm6Slot(s, id);
    if (!s && v15() && id === 96) d = { ...d, label: "TYPE" };   /* (DESC: INSRT; the device's INSERT page: TYPE) */
    if (!s && v15() && id >= 97 && id <= 99) { const x = insView(id, d); rename = x.rename || null; d = { ...x }; delete d.rename; }
    const sync = esync(s, id);
    if (sync) { d = { ...d, fmt: F.INT, unit: "" }; rename = (x) => ESYNC_NAMES[esyncStep(+x)]; }
    const r = paramRow(d, value(s, id), (v) => {
      if (sync) v = esyncValue(esyncStep(v));     /* (as the device's knob: by name, the first value showing it) */
      dev.setParam(s, id, v); redraw(s, id); ui.changed(s, id, v);
      if (!s && v15() && (id === 96 || id === 102)) build(dev);   /* (A B C / ATK DEC REL take another meaning) */
    }, { icon: (v) => paramIcon(desc(s, id), v, engineAt), rename });
    if (!s && v15() && id >= 97 && id <= 100) r.el.classList.toggle("dim", !dev.dump.p[96]);   /* (TYPE OFF) */
    rows.set(key(s, id), r);
    return r.el;
  }

  /* ---- the voice: engine, preset, prev / next, init ---- */
  function voice() {
    const e = dev.dump.engine, names = dev.names[e] || [], eng = dev.info.engines[e] || "";
    const shown = names.map((_, i) => i).filter((i) => aliasOf(names, i) === i);
    const at = Math.max(0, shown.indexOf(aliasOf(names, dev.dump.preset)));
    const engSel = el("select", { "aria-label": t("engine") },
      ...engineOrder(dev.info.engines).map((i) => el("option", { value: i, text: dev.info.engines[i] })));
    engSel.value = String(e);
    engSel.addEventListener("change", () => dev.loadPreset(+engSel.value, 0));
    const preSel = el("select", { "aria-label": t("preset") }, ...shown.map((i) => el("option", { value: i, text: names[i] })));
    preSel.value = String(aliasOf(names, dev.dump.preset));
    preSel.addEventListener("change", () => dev.loadPreset(e, +preSel.value));
    const step = (dir) => { const n = shown[(at + dir + shown.length) % shown.length]; if (n != null) dev.loadPreset(e, n); };
    return el("section", { class: "card wide voice" },
      ic(ENGINE_IC[eng] || "ui_knob", "eng"),
      el("div", { class: "who" },
        el("div", { class: "name", text: names[dev.dump.preset] || "—" }),
        el("div", { class: "meta" },
          el("label", { class: "pick" }, el("span", { class: "lbl", text: t("engine") }), el("b", { text: eng }), engSel),
          el("label", { class: "pick" }, el("span", { class: "lbl", text: t("preset") }), el("b", { text: `${at + 1}` }), el("span", { class: "lbl", text: `/ ${shown.length}` }), preSel))),
      el("div", { class: "acts" },
        el("button", { type: "button", class: "btn", onclick: () => step(-1) }, ic("control_arrow_back"), t("prev")),
        el("button", { type: "button", class: "btn", onclick: () => step(1) }, ic("control_arrow_forward"), t("next")),
        el("button", { type: "button", class: "btn", onclick: async () => { if (await ui.confirm(t("initQ"))) dev.initSound(); } }, ic("control_arrow_randomize"), t("init"))));
  }

  /* ---- a group: one card, pages as cells ---- */
  function group(g) {
    const eng = dev.info.engines[dev.dump.engine] || "";
    const title = g.engine ? eng || "EDIT" : g.t;
    if (g.mod != null) {
      const body = [];
      for (let k = 0; k < 4; k++) {
        const ids = [0, 1, 2].map((j) => g.mod + 3 * k + j);
        const parts = ids.map((id) => row(0, id));
        if (parts.some((x) => !x)) continue;
        body.push(el("div", { class: "modrow", role: "group", "aria-label": `${g.t} ${k + 1}` },
          el("span", { class: "n", text: String(k + 1) }), ...parts));
      }
      return body.length ? card(g.t, HEAD_IC.MOD, el("div", { class: "rows" }, ...body)) : null;
    }
    const pages = g.pages.map(([name, s, ids], k) => {
      const tt = g.engine && (dev.titles[dev.dump.engine] || [])[k];
      return { name: tt || name, rows: ids.map((id) => row(s, id)).filter(Boolean) };
    }).filter((p) => p.rows.length);
    if (!pages.length) return null;
    const box = el("div", { class: "rows" });
    let k = Math.min(pageOf.get(g.t) || 0, pages.length - 1);
    const show = (n) => { k = n; pageOf.set(g.t, n); box.replaceChildren(...pages[n].rows); };
    const c = card(title, g.engine ? ENGINE_IC[eng] || HEAD_IC.EDIT : HEAD_IC[g.t]);
    if (g.viz) { viz[g.viz] = svg("svg", { class: "viz", viewBox: "0 0 300 88", preserveAspectRatio: "none", "aria-hidden": "true" }); c.append(viz[g.viz]); }
    if (pages.length > 1) c.append(el("div", { class: "pages" }, cells(pages.map((p) => p.name), k, show, title).el));
    c.append(box);
    show(k);
    return c;
  }

  /* ---- the envelope and the LFO, from their values ---- */
  function drawEnv() {
    if (!viz.env) return;
    const p = dev.dump.p, w = (v) => 8 + (v / 127) * 64;      /* ATK DEC REL: log time -> width */
    const a = w(p[1]), dd = w(p[2]), r = w(p[4]), s = p[3] / 127;
    const y0 = 80, top = 8, ys = y0 - s * (y0 - top), x1 = 4 + a, x2 = x1 + dd, x3 = 296 - r;
    const path = `M4 ${y0} C ${4 + a * 0.4} ${top + 10} ${x1 - a * 0.2} ${top} ${x1} ${top} C ${x1 + dd * 0.3} ${ys} ${x2 - dd * 0.3} ${ys} ${x2} ${ys} L ${x3} ${ys} C ${x3 + r * 0.3} ${y0} ${296 - r * 0.2} ${y0} 296 ${y0}`;
    viz.env.replaceChildren(svg("line", { class: "base", x1: 0, y1: y0 + 0.5, x2: 300, y2: y0 + 0.5 }),
      svg("path", { class: "area", d: path + " Z" }), svg("path", { class: "curve", d: path }), svg("circle", { class: "knee", cx: x2, cy: ys, r: 3 }));
  }
  function drawLfo() {
    if (!viz.lfo) return;
    const d = dev.pdesc[10], wave = d && d.names ? d.names[dev.dump.p[10] - d.min] || "SIN" : "SIN";
    const cyc = 1 + Math.round(dev.dump.p[9] / 127 * 5), n = 240;
    let path = "", seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
    let held = rnd();
    for (let i = 0; i <= n; i++) {
      const ph = (i / n) * cyc % 1, x = 4 + (i / n) * 292;
      if (wave === "S&H" && i && Math.floor((i / n) * cyc * 4) !== Math.floor(((i - 1) / n) * cyc * 4)) held = rnd();
      const v = wave === "TRI" ? 1 - 4 * Math.abs(ph - 0.5) : wave === "SAW" ? 1 - 2 * ph : wave === "SQR" ? (ph < 0.5 ? 1 : -1)
        : wave === "S&H" ? held : Math.sin(ph * 2 * Math.PI);
      path += (i ? " L " : "M ") + x.toFixed(1) + " " + (44 - v * 32).toFixed(1);
    }
    viz.lfo.replaceChildren(svg("line", { class: "base", x1: 0, y1: 44.5, x2: 300, y2: 44.5 }), svg("path", { class: "curve", d: path }));
  }
  function redraw(s, id) { if (s) return; if (id >= 1 && id <= 4) drawEnv(); else if (id === 9 || id === 10) drawLfo(); marks(); }
  /* as the device shows them (1.4): the LFO's RATE dim while SYNC (91) is on; ANALOG's DTN / MIX named SYNC / SUB
     while WAVE is SYNC / SUB (DESC keeps the plain labels) */
  function marks() {
    if (!dev || !dev.dump || dev.info.pe0 < 96) return;
    const rate = rows.get(key(0, 9)), pe0 = dev.info.pe0;
    if (rate) rate.el.classList.toggle("dim", !!dev.dump.p[91]);
    if (dev.engineName() !== "ANALOG") return;
    const w = dev.pdesc[pe0], wave = w && w.names ? w.names[dev.dump.p[pe0] - w.min] : "";
    for (const [k, alt] of [[1, "SYNC"], [2, "SUB"]]) {
      const r = rows.get(key(0, pe0 + k)), l = r && r.el.querySelector(".lbl");
      if (l && dev.pdesc[pe0 + k]) l.textContent = wave === alt ? alt : dev.pdesc[pe0 + k].label;
    }
  }

  /* an FM6 track: PARAMETERS (the device's macros, as on the device) or 6-OP (the whole patch) */
  const TAB_KEY = "felucca-editor-soundtab";
  const fm6Box = el("div");
  const fm6 = fm6Screen(fm6Box, ui);
  let tab = store.get(TAB_KEY) === "6op" ? 1 : 0;
  function build(device) {
    dev = device;
    rows.clear(); viz = {};
    if (!dev || !dev.dump) { root.replaceChildren(); built = ""; return; }
    const grid = el("div", { class: "grid" }, voice());
    if (knownLayout(dev.info)) {
      for (const g of LAYOUT(dev.info.pe0, dev.engineName())) if (g.place === "sound") { const c = group(g); if (c) grid.append(c); }
    } else {                                        /* an unknown firmware layout: everything in id order */
      const all = el("div", { class: "rows" });
      for (let i = 0; i < dev.info.pcount; i++) { const r = row(0, i); if (r) all.append(r); }
      grid.append(card("PARAMETERS", "ui_knob", all));
    }
    if (dev.engineName() === "FM6" && dev.fm6Ok()) {
      const show = (i) => { tab = i; store.set(TAB_KEY, i ? "6op" : "params"); grid.hidden = !!i; fm6Box.hidden = !i; if (i) fm6.show(dev); else fm6.leave(); };
      root.replaceChildren(el("div", { class: "subtabs" }, cells(["PARAMETERS", "6-OP"], tab, show, "FM6").el), grid, fm6Box);
      show(tab);
    } else {
      fm6.leave();
      root.replaceChildren(grid);
    }
    drawEnv(); drawLfo(); marks();
    built = signature();
  }
  const signature = () => (dev && dev.dump ? JSON.stringify([getLang(), dev.dump.engine, dev.dump.preset, dev.sel, dev.pdesc.slice(dev.info.pe0)]) : "");
  return {
    /* the whole sound (after a load, RELOAD, another track): rebuilt when its shape changed, else values only */
    show(device) { if (device !== dev || signature() !== built) build(device); else refresh(); },
    refresh,
    param(s, id, v) {
      if (!s && dev && dev.dump && v15() && (id === 96 || id === 102) && rows.get(key(s, id)) && !rows.get(key(s, id)).busy()) return build(dev);   /* (1.5) */
      const r = rows.get(key(s, id)); if (r) { r.update(v); redraw(s, id); }
    },
  };
  function refresh() {
    if (!dev || !dev.dump) return;
    for (const [k, r] of rows) { const [s, id] = k.split(":").map(Number); r.update(value(s, id), false); }
    drawEnv(); drawLfo(); marks();
  }
}
