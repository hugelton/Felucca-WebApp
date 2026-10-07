// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// SEQ: the selected track's steps, 16 a page (as the device's keys), the step under the cursor in detail, the
// pattern (LEN DIV SWG GATE) and AUTOMATION (1.0.4; MOTION before, and in the protocol). A DRUM track shows its 8 lanes as a grid; every other engine its notes.
// Arrows move the cursor, Space turns a step (a hit, on the grid) on or off, Enter goes to the step's notes.

import { F, LANES, noteName, parseNotes } from "./proto.js";
import { $$, el, ic } from "./dom.js";
import { HEAD_IC, LAYOUT, paramIcon, visible } from "./layout.js";
import { knownLayout } from "./device.js";
import { card, cells, help, paramRow } from "./parts.js";
import { t } from "./text.js";
import { cmpVersion } from "./version.js";

const TIMES = ["NOTE", "TIE", "REST"];
/* what the device calls the recorded knob moves: AUTOMATION from 1.0.4, MOTION before (the protocol's name) */
export const autoName = (version) => (cmpVersion(version, "1.0.4") >= 0 ? "AUTOMATION" : "MOTION");
/* the ids MOTION can record (EDITOR_PROTOCOL.md v7, the device's motion_param): 83 .. P_COUNT-1 are the engine's
   (1.0.x) or the DRUM lane levels and the engine's (1.1: 83..90, 91..98); not the chord keys 81, 82 */
export const motionIds = (pcount = 91) => [...Array(17).keys(), 33, 34, 35, 36, 38, 39, 44, ...Array.from({ length: 20 }, (_, k) => 61 + k),
  ...Array.from({ length: Math.max(0, pcount - 83) }, (_, k) => 83 + k)];
export const MOTION_IDS = motionIds(91);
const EMPTY = { n: 0, notes: [0, 0, 0, 0], time: 2, flags: 0, vel: 0, hit: 0, acc: 0, chance: 100, ratchet: 1 };
export const stepOn = (s) => !!s && s.time === 0 && (s.n > 0 || (s.hit | 0) > 0);
export const notesText = (s) => s.notes.slice(0, s.n).map(noteName).join(" ");
/* turning a step on: the last note played before it (or C4) at velocity 96 */
export function stepToggled(steps, k) {
  const s = steps[k] || EMPTY;
  if (stepOn(s)) return { ...s, time: 2 };
  let note = 60;
  for (let j = k - 1; j >= 0; j--) if (steps[j] && steps[j].n) { note = steps[j].notes[0]; break; }
  return s.n || s.hit ? { ...s, time: 0, vel: s.vel || 96 } : { ...s, n: 1, notes: [note, 0, 0, 0], time: 0, vel: s.vel || 96 };
}
/* a lane of step k on the grid: hit on / off (mode 0) or its accent (mode 1; an accent makes the lane hit) */
export function laneToggled(s0, lane, mode) {
  const s = { ...(s0 || EMPTY) }, bit = 1 << lane;
  if (mode === 1) { s.acc = (s.acc | 0) ^ bit; if (s.acc & bit) s.hit = (s.hit | 0) | bit; }
  else { s.hit = (s.hit | 0) ^ bit; if (!(s.hit & bit)) s.acc = (s.acc | 0) & ~bit; }
  s.acc &= s.hit;
  if (s.hit && s.time === 2) s.time = 0;
  if (s.hit && !s.vel) s.vel = 96;
  if (!s.hit && !s.n && s.time === 0) s.time = 2;
  return s;
}

export function seqScreen(root, ui) {
  let dev = null, cur = 0, bank = 0, mode = 0, gridEl = null, detail = null, motionBox = null, pattern = new Map();
  const isDrum = () => dev.engineName() === "DRUM";
  /* a page: 16 steps (the device's keys); a DRUM grid on a narrow screen: 8, so a cell stays big enough to touch */
  const narrow = typeof matchMedia === "function" ? matchMedia("(max-width: 640px)") : { matches: false, addEventListener() {} };
  const per = () => (isDrum() && narrow.matches ? 8 : 16);
  narrow.addEventListener("change", () => { if (dev && isDrum()) draw(); });
  const pages = () => Math.ceil(dev.stepLen() / per());
  const write = async (k, s) => { await dev.writeStep(k, s); };

  /* ---- the steps of the page ---- */
  function drawGrid() {
    if (!gridEl) return;
    const len = dev.stepLen(), base = bank * per();
    const focusIn = gridEl.contains(document.activeElement);
    if (isDrum()) {
      const kids = [el("span")];
      for (let i = 0; i < per(); i++) kids.push(el("span", { class: "col" + (base + i === cur ? " at" : ""), text: String(base + i + 1) }));
      LANES.forEach((ln, l) => {
        kids.push(el("span", { class: "lane-n", text: ln }));
        for (let i = 0; i < per(); i++) {
          const k = base + i, s = dev.steps[k] || EMPTY, on = s.time === 0 && (s.hit >> l) & 1, acc = on && (s.acc >> l) & 1, out = k >= len;
          kids.push(el("button", {
            type: "button", class: "hit" + (on ? " on" : "") + (acc ? " acc" : "") + (i % 4 === 0 ? " beat" : "") + (out ? " out" : "") + (k === cur ? " cur" : ""),
            "aria-label": `${ln} ${k + 1}`, "aria-pressed": String(!!on), tabindex: k === cur && l === 0 ? "0" : "-1", "data-k": k, "data-l": l,
            onclick: () => { cur = k; write(k, laneToggled(dev.steps[k], l, mode)); },
            onfocus: () => { if (cur !== k) { cur = k; drawDetail(); markCursor(); } help(`${ln} ${k + 1}`, on ? (acc ? "ACC" : "ON") : "OFF"); },
            onkeydown: (e) => gridKey(e, k, l),
          }));
        }
      });
      gridEl.className = "lanes" + (per() === 8 ? " n8" : "");
      gridEl.replaceChildren(...kids);
    } else {
      gridEl.className = "steps";
      gridEl.replaceChildren(...Array.from({ length: per() }, (_, i) => {
        const k = base + i, s = dev.steps[k] || EMPTY, on = stepOn(s), tie = s.time === 1, out = k >= len;
        const first = s.n ? noteName(s.notes[0]) + (s.n > 1 ? "+" + (s.n - 1) : "") : s.hit ? "•" : "";
        return el("button", {
          type: "button", role: "gridcell", "data-k": k, tabindex: k === cur ? "0" : "-1",
          class: "step" + (on ? " on" : "") + (on && s.flags & 1 ? " acc" : "") + (tie ? " tie" : "") + (out ? " out" : ""),
          "aria-current": String(k === cur), "aria-label": `${k + 1}: ${on ? notesText(s) || "HIT" : tie ? "TIE" : "REST"}${on && s.flags & 1 ? " ACC" : ""}${on && s.flags & 2 ? " SLD" : ""}${on && s.ratchet > 1 ? " x" + s.ratchet : ""}`,
          onclick: () => { cur = k; drawDetail(); markCursor(); },
          ondblclick: () => write(k, stepToggled(dev.steps, k)),
          onfocus: () => help(`${t("steps")} ${k + 1}`, on ? notesText(s) : tie ? "TIE" : "REST"),
          onkeydown: (e) => gridKey(e, k, 0),
        },
        el("span", { class: "k", text: String(k + 1) }),
        s.chance != null && s.chance < 100 && on ? el("span", { class: "ch", text: s.chance + "%" }) : null,
        el("span", { class: "x", text: on ? first : tie ? "—" : "" }),
        on && (s.flags & 2 || s.ratchet > 1) ? el("span", { class: "sl", "aria-hidden": "true", text: (s.flags & 2 ? "~" : "") + (s.ratchet > 1 ? "x" + s.ratchet : "") }) : null);
      }));
    }
    if (focusIn) { const b = gridEl.querySelector('[tabindex="0"]'); if (b) b.focus({ preventScroll: true }); }
  }
  function markCursor() {
    for (const b of $$("[data-k]", gridEl)) {
      const k = +b.dataset.k, on = k === cur && (!b.dataset.l || b.dataset.l === "0");
      b.tabIndex = on ? 0 : -1;
      if (b.classList.contains("step")) b.setAttribute("aria-current", String(k === cur));
      else b.classList.toggle("cur", k === cur);
    }
    for (const c of $$(".col", gridEl)) c.classList.toggle("at", +c.textContent - 1 === cur);
  }
  function gridKey(e, k, l) {
    const drum = isDrum(), base = bank * per();
    const mv = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: drum ? [0, 1] : [8, 0], ArrowUp: drum ? [0, -1] : [-8, 0] }[e.key];
    if (mv) {
      e.preventDefault();
      const i = (k - base + mv[0] + per()) % per(), nl = (l + mv[1] + 8) % 8;
      cur = base + i;
      drawDetail();
      const b = gridEl.querySelector(drum ? `[data-k="${cur}"][data-l="${nl}"]` : `[data-k="${cur}"]`);
      markCursor();
      if (b) { b.tabIndex = 0; b.focus(); }
    } else if (e.key === " ") {
      e.preventDefault();
      write(k, drum ? laneToggled(dev.steps[k], l, mode) : stepToggled(dev.steps, k));
    } else if (e.key === "Enter" && detail && detail.notes) {
      e.preventDefault(); detail.notes.focus(); detail.notes.select();
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      const n = pages();
      bank = (bank + (e.key === "PageDown" ? 1 : -1) + n) % n; cur = bank * per() + (k % per());
      draw();
    }
  }

  /* ---- the step under the cursor ---- */
  function drawDetail() {
    if (!detail) return;
    const k = cur, s = dev.steps[k] || EMPTY, set = (patch) => write(k, { ...dev.steps[k], ...patch });
    detail.card.querySelector("h2 span:nth-child(2)").textContent = `${t("steps")} ${k + 1}`;
    const notes = el("input", { class: "text", type: "text", spellcheck: "false", value: notesText(s), "aria-label": `NOTES ${k + 1}`, placeholder: "—" });
    const commit = () => {
      const n = parseNotes(notes.value);
      notes.classList.toggle("bad", !n);
      if (!n) return;
      const all = n.concat(s.notes.slice(n.length)).slice(0, 4);
      set({ n: n.length, notes: all, time: n.length && s.time === 2 ? 0 : s.time, vel: s.vel || (n.length ? 96 : 0) });
    };
    notes.addEventListener("change", commit);
    notes.addEventListener("keydown", (e) => { if (e.key === "Escape") { notes.value = notesText(s); notes.blur(); const b = gridEl.querySelector(`[data-k="${k}"]`); if (b) b.focus(); } });
    notes.addEventListener("focus", () => help("NOTES", notes.value));
    detail.notes = notes;
    const rows = [];
    rows.push(el("div", { class: "enum" }, el("span", { class: "lbl", text: "TIME" }), cells(TIMES, s.time, (i) => set({ time: i }), "TIME").el));
    rows.push(el("label", { class: "field" }, el("span", { class: "lbl", text: "NOTES" }), notes));
    rows.push(paramRow({ fmt: F.INT, min: 0, max: 127, def: 96, label: "VEL", unit: "" }, s.vel, (v, final) => { if (final) set({ vel: v }); }, { icon: "symbol_volume" }).el);
    if (dev.info.chance) rows.push(paramRow({ fmt: F.PCT, min: 0, max: 100, def: 100, label: "CHANCE", unit: "%" }, s.chance ?? 100,
      (v, final) => { if (final) set({ chance: v }); }, { icon: "symbol_dice" }).el);
    if (dev.info.chance && dev.info.ratchet)          /* RATCH (1.0.5): the step's hits, x1 .. x4 (as the device's STEP page) */
      rows.push(el("div", { class: "enum" }, el("span", { class: "lbl", text: "RATCH" }),
        cells(Array.from({ length: dev.info.ratchet }, (_, i) => "x" + (i + 1)), (s.ratchet || 1) - 1, (i) => set({ ratchet: i + 1, chance: s.chance ?? 100 }), "RATCH").el));
    const flag = (bit, name) => el("button", { type: "button", class: "chip", "aria-pressed": String(!!(s.flags & bit)),
      onclick: () => set({ flags: s.flags ^ bit, time: s.time === 2 && (s.n || s.hit) ? 0 : s.time }) }, name);
    rows.push(el("div", { class: "chips" }, flag(1, "ACC"), flag(2, "SLD"),
      el("button", { type: "button", class: "chip", onclick: () => write(k, stepToggled(dev.steps, k)), "aria-pressed": String(stepOn(s)) }, "ON")));
    detail.body.replaceChildren(...rows);
    drawMotion();
  }

  /* ---- MOTION: the track's recorded knob moves; those of the step under the cursor, and add one ---- */
  function drawMotion() {
    if (!motionBox) return;
    const m = dev.motion;
    if (!m) { motionBox.card.hidden = true; return; }
    motionBox.card.hidden = false;
    motionBox.card.aside.textContent = `${m.count} / ${m.max}`;
    const evs = m.events.filter((e) => e.step === cur);
    const rows = evs.map((e) => {
      const d = dev.pdesc[e.param];
      /* (a lock, 1.1: its value set as a lock again; op 3 would make it an automation event) */
      const r = d ? paramRow(d, e.value, (v, final) => { if (final) dev.motionOp(e.lock ? 5 : 3, { ...e, value: v }); },
        { icon: (v) => paramIcon(d, v), label: e.lock ? d.label + " · LOCK" : d.label }) : null;
      return el("div", { class: "evrow" }, r ? r.el : el("span", { text: `P${e.param}` }),
        el("button", { type: "button", class: "iconbtn", "aria-label": `${d ? d.label : e.param} ×`, onclick: () => dev.motionOp(4, e) }, ic("symbol_trash")));
    });
    const can = motionIds(dev.info.pcount).filter((id) => visible(dev.pdesc[id]) && !evs.some((e) => e.param === id));
    const pick = el("select", { "aria-label": autoName(dev.info.version) }, ...can.map((id) => el("option", { value: id, text: dev.pdesc[id].label + (id >= dev.info.pe0 ? " · " + dev.engineName() : "") })));
    const add = el("button", { type: "button", class: "btn", disabled: !can.length || m.count >= m.max,
      onclick: () => { const id = +pick.value; dev.motionOp(3, { step: cur, param: id, value: dev.dump.p[id] }); } }, ic("control_add"), `${t("steps")} ${cur + 1}`);
    motionBox.body.replaceChildren(
      el("div", { class: "enum" }, el("span", { class: "lbl", text: "PLAY" }), cells(["OFF", "ON"], m.on ? 1 : 0, (i) => dev.motionOp(1, { on: !!i }), autoName(dev.info.version)).el),
      el("div", { class: "steps-mini" + (per() === 8 ? " n8" : ""), "aria-hidden": "true" }, ...Array.from({ length: per() }, (_, i) => {
        const k = bank * per() + i, n = m.events.filter((e) => e.step === k).length;
        return el("span", { class: (n ? "on" : "") + (k === cur ? " at" : "") });
      })),
      el("div", { class: "rows" }, ...rows),
      el("div", { class: "addrow" }, el("label", { class: "pick sel" }, el("span", { class: "lbl", text: can.length ? dev.pdesc[can[0]].label : "—" }), pick), add),
      el("div", { class: "acts" }, el("button", { type: "button", class: "btn", disabled: !m.count,
        onclick: async () => { if (await ui.confirm(`CLEAR ${autoName(dev.info.version)}?`)) dev.motionOp(2); } }, ic("symbol_trash"), "CLEAR")));
    pick.addEventListener("change", () => { pick.previousElementSibling.textContent = dev.pdesc[+pick.value].label; });
  }

  function patternCard() {
    pattern = new Map();
    const g = LAYOUT(dev.info.pe0).find((x) => x.place === "seq");
    const ids = knownLayout(dev.info) ? g.pages[0][2] : [];
    const rows = ids.map((id) => {
      const d = dev.pdesc[id];
      if (!visible(d)) return null;
      const r = paramRow(d, dev.dump.p[id], (v) => { dev.setParam(0, id, v); if (id === dev.pSlen()) { bank = Math.min(bank, pages() - 1); drawGrid(); drawBanks(); } }, { icon: (v) => paramIcon(d, v) });
      pattern.set(id, r);
      return r.el;
    }).filter(Boolean);
    return rows.length ? card("PATTERN", HEAD_IC.PATTERN, el("div", { class: "rows" }, ...rows)) : null;
  }

  let banksEl = null, modeEl = null;
  function drawBanks() {
    if (!banksEl) return;
    const n = pages();
    banksEl.replaceChildren(cells(Array.from({ length: n }, (_, b) => `${b * per() + 1}–${Math.min(dev.stepLen(), b * per() + per())}`), Math.min(bank, n - 1),
      (b) => { bank = b; cur = b * per() + (cur % per()); drawGrid(); drawDetail(); }, t("page")).el);
    modeEl.hidden = !isDrum();
  }

  function draw() {
    if (!dev || !dev.dump || !dev.steps.length) { root.replaceChildren(); gridEl = detail = motionBox = null; return; }
    bank = Math.min(bank, pages() - 1); cur = Math.min(cur, dev.info.nstep - 1);
    gridEl = el("div", { class: "steps", role: "grid" });
    banksEl = el("div", { class: "banks" });
    modeEl = el("div", { class: "mode" }, cells(["HIT", "ACC"], mode, (i) => { mode = i; }, "MODE").el);
    const steps = el("section", { class: "card wide" },
      el("h2", {}, ic(isDrum() ? "symbol_drum" : HEAD_IC.PATTERN), el("span", { text: isDrum() ? "GRID" : "STEPS" }),
        el("span", { class: "aside", text: `LEN ${dev.stepLen()}` })),
      el("div", { class: "bankbar" }, banksEl, modeEl,
        el("span", { class: "spacer" }),
        el("button", { type: "button", class: "btn", onclick: () => dev.reloadSteps() }, ic("control_arrow_loop"), "RELOAD"),
        el("button", { type: "button", class: "btn", onclick: async () => { if (await ui.confirm("CLEAR SEQUENCE?")) dev.clearSequence(); } }, ic("symbol_trash"), "CLEAR")),
      gridEl);
    const dc = card(`${t("steps")} ${cur + 1}`, "symbol_pencil");
    detail = { card: dc, body: el("div", { class: "rows" }) };
    dc.append(detail.body);
    const mc = card(autoName(dev.info.version), "symbol_motion");
    motionBox = { card: mc, body: el("div", { class: "rows" }) };
    mc.append(motionBox.body);
    const pc = patternCard();
    root.replaceChildren(el("div", { class: "grid" }, steps, dc, ...(pc ? [pc] : []), ...(dev.info.motionMax ? [mc] : [])));
    drawBanks(); drawGrid(); drawDetail();
  }

  return {
    show(device) { dev = device; draw(); },
    step(k) {
      if (!dev || !gridEl) return;
      if (k >= bank * per() && k < bank * per() + per()) drawGrid();
      if (k === cur && !(detail && detail.card.contains(document.activeElement))) drawDetail();
    },
    steps() { if (dev) draw(); },
    motion() { if (dev && motionBox && !motionBox.card.contains(document.activeElement)) drawMotion(); },
    param(s, id, v) {
      if (s || !dev) return;
      const r = pattern.get(id);
      if (r) r.update(v);
      if (id === dev.pSlen()) { drawBanks(); drawGrid(); }
    },
  };
}
