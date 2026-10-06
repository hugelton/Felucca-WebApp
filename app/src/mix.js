// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// MIX: the four tracks side by side, as the device's MIXER page: the track's number (it selects the track),
// its sound, REC when armed, the level fader, MUTE, PAN and REV. The selected track's strip and SOUND follow
// each other (device.js mixFromDump). The device sends no levels, so there is no meter.

import { F, fmtValue } from "./proto.js";
import { el, ic } from "./dom.js";
import { help, paramRow } from "./parts.js";
import { t } from "./text.js";

export function mixScreen(root) {
  let dev = null;
  const strips = [];

  function strip(k) {
    const lvDesc = dev.pdesc[0] || { fmt: F.INT, min: 0, max: 127, def: 100, label: "LEVEL", unit: "" };
    const panDesc = dev.pdesc[dev.panId()] || { fmt: F.BIPCT, min: -64, max: 63, def: 0, label: "PAN", unit: "" };
    const revDesc = dev.pdesc[dev.revId()] || { fmt: F.PCT, min: 0, max: 127, def: 0, label: "REV", unit: "" };
    const x = () => dev.mix.tracks[k];
    const cush = el("button", { type: "button", class: "cushbtn", onclick: () => dev.selectTrack(k) }, el("span", { class: "cush", "aria-hidden": "true", text: String(k + 1) }));
    const snd = el("span", { class: "snd" });
    const rec = el("span", { class: "chip rec", text: "REC", hidden: true });
    /* the level: a gauge row stood up (filled from the bottom, the value, its unit and the label stacked in the middle) */
    const lvl = el("span", { class: "v" });
    const fader = el("div", { class: "vgauge" }, el("span", { class: "fill" }),
      el("span", { class: "stack" }, lvl, el("span", { class: "lbl", text: lvDesc.label })));
    const input = el("input", { type: "range", min: 0, max: 127, step: 1 });
    fader.append(input);
    let dragging = false;
    const showLevel = (v) => {
      fader.style.setProperty("--p", (v / 127 * 100).toFixed(1) + "%");
      const [a, u] = fmtValue(lvDesc, v);
      lvl.replaceChildren(document.createTextNode(a), u ? el("small", { text: u }) : null);
      input.setAttribute("aria-valuetext", u ? `${a} ${u}` : a);
    };
    const level = (v, final) => { showLevel(v); help(`${t("track")} ${k + 1} ${lvDesc.label}`, input.getAttribute("aria-valuetext")); dev.setMix(k, v, x().mute); };
    input.addEventListener("input", () => level(+input.value, false));
    input.addEventListener("change", () => level(+input.value, true));
    input.addEventListener("pointerdown", () => { dragging = true; fader.classList.add("hot"); });
    for (const ev of ["pointerup", "pointercancel", "blur"]) input.addEventListener(ev, () => { dragging = false; fader.classList.remove("hot"); });
    input.addEventListener("dblclick", () => { input.value = String(lvDesc.def); level(lvDesc.def, true); });
    input.addEventListener("focus", () => help(`${t("track")} ${k + 1} ${lvDesc.label}`, input.getAttribute("aria-valuetext")));
    input.addEventListener("keydown", (e) => {
      const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!dir || !e.shiftKey) return;
      e.preventDefault(); const v = Math.max(0, Math.min(127, +input.value + dir * 10)); input.value = String(v); level(v, true);
    });
    const mute = el("button", { type: "button", class: "chip", onclick: () => dev.setMix(k, x().level, !x().mute) }, ic("control_speaker_mute"), "MUTE");
    const pan = paramRow(panDesc, x().pan ?? 0, (v, final) => dev.setTrackParam(k, "pan", v, final), { icon: "symbol_pan", label: panDesc.label });
    const rev = paramRow(revDesc, x().rev ?? 0, (v, final) => dev.setTrackParam(k, "rev", v, final), { icon: "symbol_spring", label: revDesc.label });
    const box = el("div", { class: "strip", role: "group" }, el("div", { class: "head" }, cush, rec), snd, fader, mute, pan.el, rev.el);
    const s = {
      el: box,
      update() {
        const y = x(), sel = k === dev.sel;
        const name = [dev.info.engines[y.engine], (dev.names[y.engine] || [])[y.preset]].filter(Boolean).join(" ");
        box.classList.toggle("sel", sel);
        box.classList.toggle("muted", !!y.mute);
        box.setAttribute("aria-label", `${t("track")} ${k + 1}${name ? ": " + name : ""}`);
        cush.setAttribute("aria-label", `${t("track")} ${k + 1}`);
        cush.setAttribute("aria-pressed", String(sel));
        snd.textContent = name;
        rec.hidden = !y.armed;
        input.setAttribute("aria-label", `${t("track")} ${k + 1} ${lvDesc.label}`);
        if (!dragging) { input.value = String(y.level); showLevel(y.level); }
        mute.setAttribute("aria-pressed", String(!!y.mute));
        mute.setAttribute("aria-label", `${t("track")} ${k + 1} MUTE`);
        if (y.pan != null) pan.update(y.pan, false);
        if (y.rev != null) rev.update(y.rev, false);
      },
    };
    return s;
  }

  return {
    show(device) {
      dev = device;
      strips.length = 0;
      if (!dev || !dev.mix) { root.replaceChildren(); return; }
      for (let k = 0; k < dev.mix.ntrk; k++) strips.push(strip(k));
      root.replaceChildren(el("div", { class: "mixer" }, ...strips.map((s) => s.el)));
      strips.forEach((s) => s.update());
    },
    track(k) { if (strips[k]) strips[k].update(); },
    all() { strips.forEach((s) => s.update()); },
  };
}
