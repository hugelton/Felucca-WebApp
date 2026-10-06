// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// 6-OP: the whole patch of an FM6 track, which the device itself reaches only through its eight macros. Import
// .syx files (one voice or banks), pick a voice, edit it, send it to the selected track (or LIVE: while editing);
// read the track's patch or a factory one (F1..F8); export a voice. The track keeps what it was sent (SLOT OWN).

import { F, FM6, noteName } from "./proto.js";
import { el, ic } from "./dom.js";
import { card, cells, help, paramRow } from "./parts.js";
import { t, tf } from "./text.js";

const NS = "http://www.w3.org/2000/svg";
const svg = (tag, a = {}) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); return e; };
const WAVES = ["TRI", "SAW-", "SAW+", "SQR", "SIN", "S&H"];
const CURVES = ["-LIN", "-EXP", "+EXP", "+LIN"];
const D = (label, max, rename) => ({ d: { fmt: F.INT, min: 0, max, def: 0, label, unit: "", names: null }, rename });
const sign = (n) => (n > 0 ? "+" + n : String(n));
/* how a field reads (the values stay the file's) */
const SHOW = {
  DET: (x) => sign(+x - 7), TRNSP: (x) => sign(+x - 24) + " st", BP: (x) => noteName(+x + 21),
  ALG: (x) => String(+x + 1), FC: (x) => (+x === 0 ? "0.5" : x),
};
/* the shape of an EG (4 rates, 4 levels: from L4 up to L1, L2, L3, held, back to L4), drawn into box */
function eg(box, rates, levels) {
  const w = 300, h = 72, y = (l) => h - 6 - (l / 99) * (h - 14);
  const len = (r, a, b) => 6 + (99 - r) * 0.55 * (0.3 + Math.abs(a - b) / 99);
  const segs = [[rates[0], levels[3], levels[0]], [rates[1], levels[0], levels[1]], [rates[2], levels[1], levels[2]]];
  const total = segs.reduce((n, [r, a, b]) => n + len(r, a, b), 0) + 40 + len(rates[3], levels[2], levels[3]);
  const k = (w - 8) / total;
  let x = 4, d = `M${x} ${y(levels[3])}`;
  for (const [r, a, b] of segs) { x += len(r, a, b) * k; d += ` L${x.toFixed(1)} ${y(b).toFixed(1)}`; }
  const hold = x; x += 40 * k; d += ` L${x.toFixed(1)} ${y(levels[2]).toFixed(1)}`;
  x += len(rates[3], levels[2], levels[3]) * k; d += ` L${x.toFixed(1)} ${y(levels[3]).toFixed(1)}`;
  box.replaceChildren(svg("line", { class: "base", x1: 0, y1: h - 5.5, x2: w, y2: h - 5.5 }),
    svg("path", { class: "curve", d }), svg("circle", { class: "knee", cx: hold, cy: y(levels[2]), r: 3 }));
}

export function fm6Screen(root, ui) {
  let dev = null, v = FM6.init(), imported = [], picked = -1, op = 1, live = false, timer = null, busy = false, factorySel = 0;
  const rows = new Map();                           /* byte -> part (values change in place) */
  let egOp = null, egPitch = null, freqOut = null, algOut = null;
  const file = el("input", { type: "file", accept: ".syx,.SYX,.bin,application/octet-stream", hidden: true });
  file.addEventListener("change", async () => { const f = file.files[0]; file.value = ""; if (f) importFile(f); });

  const track = () => dev.sel ?? 0;
  const send = async (quiet) => { if (!dev) return; const ok = await dev.fm6Send(track(), FM6.pack(v)); if (ok && !quiet) ui.say(`${tf("didSend", `${t("track")} ${track() + 1}`)}: ${FM6.name(v)}`); };
  function set(i, val) {
    v[i] = Math.max(0, Math.min(FM6.max(i), Math.round(val)));
    if (live && dev) { clearTimeout(timer); timer = setTimeout(() => send(true), 150); }
    redraw();
  }
  function row(i, label, max, rename) {
    const r = paramRow({ fmt: F.INT, min: 0, max, def: v[i], label, unit: "", names: null }, v[i], (x) => set(i, x), { rename });
    rows.set(i, r);
    return r.el;
  }
  function choice(i, label, names) {
    const box = el("div", { class: "enum" }, el("span", { class: "lbl", text: label }),
      cells(names, v[i], (k) => { set(i, k); if (label === "MODE") draw(); }, label).el);   /* (MODE: COARSE reads otherwise) */
    return box;
  }
  function redraw() {
    const V = FM6.VI;
    if (egPitch) eg(egPitch, [V.PR1, V.PR2, V.PR3, V.PR4].map((i) => v[i]), [V.PL1, V.PL2, V.PL3, V.PL4].map((i) => v[i]));
    if (egOp) eg(egOp, ["R1", "R2", "R3", "R4"].map((f) => v[FM6.at(op, f)]), ["L1", "L2", "L3", "L4"].map((f) => v[FM6.at(op, f)]));
    if (freqOut) freqOut.textContent = FM6.freqText(v, op);
    if (algOut) {
      const a = v[V.ALG];
      algOut.textContent = `CARRIER ${FM6.carriers(a).join(" ")} · FB OP${FM6.feedbackOp(a)}`;
    }
    if (opCells) drawOpCells();
  }
  /* loaded from somewhere (a file, the track, a factory patch, INIT): every row again */
  function load(nv, from) {
    v = Uint8Array.from(nv);
    if (from) ui.say(`${from}: ${FM6.name(v)}`);
    draw();
    if (live && dev) send(true);
  }

  async function importFile(f) {
    const r = FM6.parseSysex(new Uint8Array(await f.arrayBuffer()));
    if (!r.voices.length) {
      const why = r.kinds.includes("fm4") ? t("fm6Is4op") : r.kinds.includes("other43") ? t("fm6OtherBlocks")
        : r.kinds.some((k) => k.startsWith("maker:")) ? t("fm6OtherMaker") : r.kinds.includes("universal") ? t("fm6Universal")
        : r.sysex ? t("fm6NoVoice") : t("fm6NotSysex");
      ui.say(`${f.name}: ${why}`, "warn");
      return;
    }
    imported = r.voices; picked = r.voices.length === 1 ? 0 : -1;
    const notes = [r.badSum && t("fm6BadSum"), r.short && t("fm6Short"), r.skipped && tf("skippedN", r.skipped)].filter(Boolean);
    ui.say(`${f.name}: ${r.voices.length}${notes.length ? " (" + notes.join(", ") + ")" : ""}`, notes.length ? "warn" : "info");
    if (picked === 0) load(r.voices[0].v); else draw();
  }
  async function run(fn) { if (busy || !dev) return; busy = true; draw(); try { await fn(); } finally { busy = false; draw(); } }

  /* ---- SOURCE: where the patch comes from and goes ---- */
  function source() {
    const fact = Array.from({ length: (dev && dev.info.fm6 && dev.info.fm6.factory) || FM6.FACTORY_PK.length }, (_, k) => `F${k + 1} ${FM6.name(FM6.factory(k)).trim()}`);
    const pick = el("select", { "aria-label": "FACTORY" }, ...fact.map((x, k) => el("option", { value: k, text: x })));
    pick.value = String(factorySel);
    pick.addEventListener("change", () => { factorySel = +pick.value; pick.previousElementSibling.textContent = fact[factorySel]; });
    const list = imported.length ? el("ul", { class: "list voices", role: "listbox", "aria-label": "SYSEX" },
      ...imported.map((x, k) => el("li", { class: "item", role: "option", "aria-selected": String(k === picked), tabindex: k === picked || (picked < 0 && k === 0) ? "0" : "-1",
        onclick: () => { picked = k; load(x.v); },
        onkeydown: (e) => {
          const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
          if (d) { e.preventDefault(); const n = Math.max(0, Math.min(imported.length - 1, k + d)); picked = n; load(imported[n].v); requestAnimationFrame(() => { const it = root.querySelectorAll(".voices .item")[n]; if (it) it.focus(); }); }
        } },
        el("span", { class: "tag", text: String(k + 1).padStart(2, "0") }), el("span", { text: x.name }), el("span")))) : null;
    const c = card("SOURCE", "symbol_folder_open",
      el("div", { class: "acts wrap" },
        el("button", { type: "button", class: "btn", disabled: busy || !dev, onclick: () => run(async () => { const pk = await dev.fm6Read(track()); if (pk) load(FM6.unpack(pk), `${t("track")} ${track() + 1}`); }) }, ic("symbol_download"), t("fromTrack")),
        el("button", { type: "button", class: "btn primary", disabled: busy || !dev, onclick: () => send(false) }, ic("symbol_upload"), t("toTrack")),
        el("button", { type: "button", class: "chip", "aria-pressed": String(live), onclick: () => { live = !live; if (live) send(true); draw(); } }, "LIVE")),
      el("div", { class: "acts wrap" },
        el("button", { type: "button", class: "btn", onclick: () => file.click() }, ic("symbol_folder_open"), ".SYX"),
        el("button", { type: "button", class: "btn", onclick: () => ui.download(`${(FM6.name(v).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "voice")}.syx`, new Uint8Array(FM6.singleSysex(v)), "application/octet-stream") }, ic("symbol_download_as"), t("export")),
        el("button", { type: "button", class: "btn", onclick: () => { picked = -1; load(FM6.init(), "INIT"); } }, ic("control_arrow_randomize"), "INIT")),
      el("div", { class: "addrow" }, el("label", { class: "pick sel" }, el("span", { class: "lbl", text: "FACTORY" }), el("b", { text: fact[factorySel] }), pick),
        el("button", { type: "button", class: "btn", disabled: busy, onclick: () => (dev ? run(async () => { const pk = await dev.fm6Factory(factorySel); if (pk) { picked = -1; load(FM6.unpack(pk), `F${factorySel + 1}`); } })
          : (picked = -1, load(FM6.factory(factorySel), `F${factorySel + 1}`))) }, t("load"))),
      list, file);
    c.aside.textContent = imported.length ? `${imported.length} ${t("voices")}` : "";
    c.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); c.classList.add("over"); } });
    c.addEventListener("dragleave", () => c.classList.remove("over"));
    c.addEventListener("drop", (e) => { e.preventDefault(); c.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) importFile(f); });
    return c;
  }

  /* ---- VOICE: the patch as a whole ---- */
  function voice() {
    const V = FM6.VI;
    const name = el("input", { class: "text", type: "text", maxlength: 10, value: FM6.name(v).trimEnd(), spellcheck: "false", "aria-label": "NAME" });
    name.addEventListener("change", () => { FM6.setName(v, name.value.toUpperCase()); name.value = FM6.name(v).trimEnd(); set(0, v[0]); });
    name.addEventListener("focus", () => help("NAME", name.value));
    algOut = el("span", { class: "lbl" });
    egPitch = svg("svg", { class: "viz", viewBox: "0 0 300 72", preserveAspectRatio: "none", "aria-hidden": "true" });
    return card("VOICE", "symbol_modular",
      el("label", { class: "field" }, el("span", { class: "lbl", text: "NAME" }), name),
      el("div", { class: "rows" }, row(V.ALG, "ALG", 31, SHOW.ALG), algOut, row(V.FB, "FB", 7), row(V.TRNSP, "TRANSPOSE", 48, SHOW.TRNSP)),
      choice(V.OKS, "KEY SYNC", ["OFF", "ON"]),
      el("h3", { class: "sub", text: "LFO" }),
      choice(V.LFW, "WAVE", WAVES),
      el("div", { class: "rows" }, row(V.LFS, "SPEED", 99), row(V.LFD, "DELAY", 99), row(V.LPMD, "PMD", 99), row(V.LAMD, "AMD", 99), row(V.LPMS, "PMS", 7)),
      choice(V.LKS, "SYNC", ["OFF", "ON"]),
      el("h3", { class: "sub", text: "PITCH EG" }), egPitch,
      el("div", { class: "rows two" }, ...[1, 2, 3, 4].map((k) => row(V["PR" + k], "R" + k, 99)), ...[1, 2, 3, 4].map((k) => row(V["PL" + k], "L" + k, 99))));
  }

  /* ---- OPERATORS: one at a time (the carriers marked) ---- */
  let opCells = null;
  function drawOpCells() {
    const car = FM6.carriers(v[FM6.VI.ALG]);
    opCells.replaceChildren(cells([1, 2, 3, 4, 5, 6].map((n) => ({ text: `${car.includes(n) ? "●" : ""}${n} · ${v[FM6.at(n, "OL")]}`, label: `OP${n}${car.includes(n) ? " CARRIER" : ""}` })),
      op - 1, (k) => { op = k + 1; draw(); }, "OP").el);
  }
  function operators() {
    const n = op, A = (f) => FM6.at(n, f);
    opCells = el("div", { class: "opcells" });
    egOp = svg("svg", { class: "viz", viewBox: "0 0 300 72", preserveAspectRatio: "none", "aria-hidden": "true" });
    freqOut = el("b", { class: "freq" });
    const c = el("section", { class: "card wide" }, el("h2", {}, ic("function_env_adsr_exp"), el("span", { text: `OPERATOR ${n}` }), el("span", { class: "aside" }, freqOut)),
      opCells,
      el("div", { class: "opgrid" },
        el("div", {}, el("h3", { class: "sub", text: "EG" }), egOp,
          el("div", { class: "rows two" }, ...[1, 2, 3, 4].map((k) => row(A("R" + k), "R" + k, 99)), ...[1, 2, 3, 4].map((k) => row(A("L" + k), "L" + k, 99))),
          el("div", { class: "rows" }, row(A("OL"), "LEVEL", 99), row(A("KVS"), "VELOCITY", 7), row(A("AMS"), "AMS", 3))),
        el("div", {}, el("h3", { class: "sub", text: "FREQUENCY" }),
          choice(A("MODE"), "MODE", ["RATIO", "FIXED"]),
          el("div", { class: "rows" }, row(A("FC"), "COARSE", 31, v[A("MODE")] ? null : SHOW.FC), row(A("FF"), "FINE", 99), row(A("DET"), "DETUNE", 14, SHOW.DET)),
          el("h3", { class: "sub", text: "KEY SCALING" }),
          el("div", { class: "rows" }, row(A("BP"), "BREAK", 99, SHOW.BP), row(A("LD"), "L DEPTH", 99), row(A("RD"), "R DEPTH", 99)),
          choice(A("LC"), "L CURVE", CURVES), choice(A("RC"), "R CURVE", CURVES),
          el("div", { class: "rows" }, row(A("RS"), "RATE SCALE", 7)))));
    return c;
  }

  function draw() {
    rows.clear();
    if (!dev || !dev.fm6Ok()) { root.replaceChildren(); return; }
    root.replaceChildren(el("div", { class: "grid" }, source(), voice(), operators()));
    redraw();
  }
  return {
    show(device) { dev = device && device.loaded ? device : null; draw(); },
    leave() { live = false; clearTimeout(timer); },
    get patch() { return v; },
  };
}
