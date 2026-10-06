// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// The controls. A parameter is one row: the value on the left, the label on the right, filled from the left
// (bipolar ones from the centre). The row is a native range input (or select) under the drawing, so keyboard,
// screen readers and touch work as the platform does. Plus cells (a choice among a few) and the help bar hook.

import { F, aliasOf, enumShown, fmtValue } from "./proto.js";
import { el, ic, put } from "./dom.js";

let helpSink = () => {};
/* the help bar: the name of what was touched and its value, nothing else */
export function onHelp(fn) { helpSink = fn; }
export const help = (name, value = "") => helpSink(name, value);

/* a row the device changed: a short mark (none with reduced motion: the CSS) */
const flash = (row) => { row.classList.remove("pulse"); void row.offsetWidth; row.classList.add("pulse"); };
const fmt = (d, v, rename) => { const [x, u] = fmtValue(d, v); return [rename ? rename(x) : x, u]; };
export const isChoice = (d) => d.fmt === F.ENUM || d.fmt === F.NOTE || d.fmt === F.ONOFF;

/* d: a DESC; value: now; onset(v, final); opt: {icon, label, rename (an ENUM text -> shown text), hot} */
export function paramRow(d, value, onset, opt = {}) {
  const label = opt.label || d.label;
  return isChoice(d) ? choiceRow(d, value, onset, opt, label) : gaugeRow(d, value, onset, opt, label);
}

function gaugeRow(d, value, onset, opt, label) {
  const bip = d.min < 0 && d.max > 0;
  const val = el("span", { class: "v" }), fill = el("span", { class: "fill" });
  const input = el("input", { type: "range", min: d.min, max: d.max, step: 1, value, "aria-label": label });
  const row = el("div", { class: "gauge" + (bip ? " bip" : "") }, fill, val,
    el("span", { class: "l" }, opt.icon ? ic(opt.icon) : null, el("span", { class: "lbl", text: label })), input);
  let dragging = false, cur = value;
  const show = (v) => {
    cur = v;
    const [x, u] = fmt(d, v, opt.rename);
    put(val, document.createTextNode(x), u ? el("small", { text: u }) : null);
    row.style.setProperty("--p", ((v - d.min) / (d.max - d.min || 1) * 100).toFixed(2) + "%");
    input.setAttribute("aria-valuetext", u ? `${x} ${u}` : x);
  };
  const say = () => help(label, input.getAttribute("aria-valuetext"));
  const set = (v, final) => { v = Math.max(d.min, Math.min(d.max, v)); if (String(v) !== input.value) input.value = String(v); show(v); say(); onset(v, final); };
  input.addEventListener("input", () => set(+input.value, false));
  input.addEventListener("change", () => set(+input.value, true));
  input.addEventListener("pointerdown", () => { dragging = true; row.classList.add("hot"); });
  const up = () => { if (dragging) { dragging = false; row.classList.remove("hot"); } };
  input.addEventListener("pointerup", up); input.addEventListener("pointercancel", up); input.addEventListener("blur", up);
  input.addEventListener("dblclick", () => set(d.def, true));
  input.addEventListener("focus", say);
  input.addEventListener("pointerenter", say);
  input.addEventListener("keydown", (e) => {        /* Shift + arrows: steps of 10 (plain arrows are the input's own) */
    const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!dir || !e.shiftKey) return;
    e.preventDefault(); set(cur + dir * 10, true);
  });
  let acc = 0;
  input.addEventListener("wheel", (e) => {          /* the wheel moves a focused row only (a page scroll stays a scroll) */
    if (document.activeElement !== input) return;
    e.preventDefault();
    acc += (e.deltaMode === 1 ? 33 : 1) * (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? -e.deltaY : e.deltaX);
    const n = Math.trunc(acc / 50);
    if (n) { acc -= n * 50; set(cur + n * (e.shiftKey ? 10 : 1), true); }
  }, { passive: false });
  show(value);
  return {
    el: row, desc: d,
    /* a value from the device: not while the user holds the row */
    /* a value from the device (pulse: it changed there): not while the user holds the row */
    update(v, pulse = true) { if (dragging || v == null || v === cur) return; input.value = String(v); show(v); if (pulse) flash(row); },
    busy: () => dragging,
  };
}

function choiceRow(d, value, onset, opt, label) {
  const val = el("span", { class: "v" });
  const select = el("select", { "aria-label": label });
  for (const v of enumShown(d)) {                   /* (note divisions longest first: #48) */
    const [x] = fmt(d, v, opt.rename);
    const alias = d.fmt === F.ENUM && d.names && aliasOf(d.names, v - d.min) !== v - d.min;   /* shown when set, not offered */
    select.append(el("option", { value: v, text: d.fmt === F.ENUM && d.names[v - d.min] == null ? String(v) : x, hidden: alias }));
  }
  const row = el("div", { class: "gauge choice" }, val,
    el("span", { class: "l" }, opt.icon ? ic(opt.icon) : null, el("span", { class: "lbl", text: label })), select);
  const show = (v) => { const [x, u] = fmt(d, v, opt.rename); put(val, document.createTextNode(x), u ? el("small", { text: u }) : null); select.value = String(v); };
  select.addEventListener("change", () => { show(+select.value); help(label, val.textContent); onset(+select.value, true); });
  select.addEventListener("focus", () => help(label, val.textContent));
  select.addEventListener("pointerenter", () => help(label, val.textContent));
  show(value);
  return {
    el: row, desc: d,
    update(v, pulse = true) { if (document.activeElement === select || v == null || String(v) === select.value) return; show(v); if (pulse) flash(row); },
    busy: () => document.activeElement === select,
  };
}

/* a choice among a few: [{text, icon, label}] or strings; the chosen one filled; arrows move */
export function cells(opts, sel, onpick, aria) {
  const box = el("div", { class: "cells", role: "radiogroup", "aria-label": aria || null });
  const draw = (k) => {
    box.replaceChildren(...opts.map((o, i) => {
      const x = typeof o === "string" ? { text: o } : o;
      return el("button", {
        type: "button", class: "cell", role: "radio", "aria-checked": String(i === k), tabindex: i === k ? "0" : "-1",
        "aria-label": x.label || null,
        onclick: () => { draw(i); onpick(i); },
        onkeydown: (e) => {
          const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
          if (!dir) return;
          e.preventDefault();
          const n = (i + dir + opts.length) % opts.length;
          draw(n); onpick(n); box.children[n].focus();
        },
      }, x.icon ? ic(x.icon) : null, x.icon && !x.text ? null : document.createTextNode(x.text));
    }));
  };
  draw(sel);
  return { el: box, set: draw };
}

/* a card: title (with an icon), an aside on the right, then the body */
export function card(title, icon, ...body) {
  const aside = el("span", { class: "aside" });
  const h = el("h2", {}, icon ? ic(icon) : null, el("span", { text: title }), aside);
  const c = el("section", { class: "card" }, h, ...body);
  c.aside = aside;
  return c;
}
