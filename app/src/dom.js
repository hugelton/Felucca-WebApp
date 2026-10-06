// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// DOM helpers: $, el (builds elements; no HTML strings anywhere), icons by Fukiai glyph name.

import { GLYPH } from "./glyphs.js";

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

/* el("button", {class, text, onclick, "aria-label", hidden: true}, ...children): false / null attributes are left out */
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "text") e.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...kids.filter((x) => x != null && x !== false));
  return e;
}

/* node's children become kids, null / false left out (replaceChildren itself would write "null") */
export function put(node, ...kids) { node.replaceChildren(...kids.filter((x) => x != null && x !== false)); return node; }

export const glyph = (name) => (GLYPH[name] ? String.fromCodePoint(GLYPH[name]) : "");
export const ic = (name, cls = "") => el("span", { class: "ic" + (cls ? " " + cls : ""), "aria-hidden": "true", text: glyph(name) });
/* the static markup's <span data-i="name"> */
export function icons(root = document) {
  for (const s of root.querySelectorAll("[data-i]")) { s.classList.add("ic"); s.textContent = glyph(s.dataset.i); s.setAttribute("aria-hidden", "true"); }
}

/* the device's engine icons (src/icons.c engine_icon, tools/gen_aa_icons.py) */
export const ENGINE_IC = {
  ANALOG: "waveform_variant", FM6: "symbol_modular", DIGITAL: "symbol_node", PHASE: "function_phase", LOFI: "function_mask",
  SAMPLE: "symbol_audio", VOICE: "symbol_mouth", TRIO: "symbol_primitives_o", WHEEL: "symbol_drawbar", SLICE: "symbol_comb",
  GRAIN: "symbol_cloud_o", PHYS: "symbol_pick", DRUM: "symbol_drum", NOISE: "waveform_noise_white",
};

export const store = {
  get(k, def = null) { try { const v = localStorage.getItem(k); return v == null ? def : v; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
