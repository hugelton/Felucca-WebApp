// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// SAMPLES: the device's three user sample slots. Each shows what it holds and a draft: files (chosen or dropped)
// or recordings from an input, each zone with its root note, its keys, its trim (the waveform's ends dragged,
// or START / END typed), a preview at the stored rate; then WRITE puts the draft in the slot.

import { SMP, noteName, parseNote, resample, zoomView } from "./proto.js";
import { el, ic, put } from "./dom.js";
import { Draft, MAX_DATA, NAME_MAX, cleanName, decodeAudio } from "./samples.js";
import { card, help } from "./parts.js";
import { t } from "./text.js";

const kib = (n) => (n / 1024).toFixed(1);
const ms = (n) => Math.round(n / SMP.RATE * 1000);
/* the recorder: raw PCM from the input, mixed to mono */
const REC_WORKLET = `registerProcessor("felucca-rec", class extends AudioWorkletProcessor {
  process(inputs) {
    const i = inputs[0];
    if (i && i.length && i[0].length) {
      const n = i[0].length, m = new Float32Array(n);
      for (let c = 0; c < i.length; c++) for (let k = 0; k < n; k++) m[k] += i[c][k] / i.length;
      this.port.postMessage(m, [m.buffer]);
    }
    return true;
  }
});`;
/* the browser's decoder for what is not a plain WAV: mono at SMP.RATE */
async function browserDecode(buf) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ab = await new Ctx(1, 1, SMP.RATE).decodeAudioData(buf.slice(0));
  const x = new Float64Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < d.length; i++) x[i] += d[i] / ab.numberOfChannels; }
  return x;
}

export function samplesScreen(root, ui) {
  let dev = null, busy = false, rec = null, recStarting = false, recDevice = "", inputs = [], preview = null;
  const drafts = [0, 1, 2].map(() => new Draft());
  const boxes = [];
  const recActive = () => !!rec || recStarting;

  /* ---- the waveform: the trim's ends, dragged; the wheel zooms at the pointer, shift + wheel or a drag moves the view ---- */
  function trimView(k, i) {
    const z = drafts[k].zones[i];
    const cv = el("canvas", { class: "trim", width: 600, height: 72, "aria-hidden": "true" });
    const tok = () => { const cs = getComputedStyle(cv); const g = (n) => cs.getPropertyValue(n).trim(); return { on: g("--theme"), off: g("--raise"), end: g("--accent"), bg: g("--bg") }; };
    const draw = () => {
      const w = cv.width, h = cv.height - 6, g = cv.getContext("2d"), c = tok();
      const n = z.raw.length, v0 = z.v0 ?? 0, v1 = z.v1 ?? n, span = v1 - v0;
      if (z.pk === undefined) { z.pk = 1e-9; for (const v of z.raw) z.pk = Math.max(z.pk, Math.abs(v)); }
      const xa = (z.a - v0) / span * w, xb = (z.b - v0) / span * w;
      g.fillStyle = c.bg; g.fillRect(0, 0, w, cv.height);
      for (let x = 0; x < w; x++) {                 /* per column: the smallest and largest sample */
        const i0 = v0 + Math.floor(x / w * span), i1 = Math.max(i0 + 1, v0 + Math.floor((x + 1) / w * span));
        let lo = 0, hi = 0;
        for (let j = i0; j < i1 && j < n; j++) { lo = Math.min(lo, z.raw[j]); hi = Math.max(hi, z.raw[j]); }
        g.fillStyle = x >= xa && x < xb ? c.on : c.off;
        g.fillRect(x, h / 2 - hi / z.pk * (h / 2 - 2), 1, Math.max(1, (hi - lo) / z.pk * (h / 2 - 2)));
      }
      g.fillStyle = c.end;
      if (xa >= 0 && xa <= w) g.fillRect(Math.min(w - 2, xa), 0, 2, h);
      if (xb >= 0 && xb <= w) g.fillRect(Math.max(0, xb - 2), 0, 2, h);
      g.fillStyle = c.off; g.fillRect(0, cv.height - 3, w, 3);       /* where the view is in the whole */
      g.fillStyle = c.on; g.fillRect(v0 / n * w, cv.height - 3, Math.max(3, span / n * w), 3);
    };
    const frac = (e) => { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
    const at = (e) => { const v0 = z.v0 ?? 0, v1 = z.v1 ?? z.raw.length; return Math.round(v0 + frac(e) * (v1 - v0)); };
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const v = [z.v0 ?? 0, z.v1 ?? z.raw.length], d = e.deltaY || e.deltaX;
      if (!d) return;
      [z.v0, z.v1] = e.shiftKey || (!e.deltaY && e.deltaX) ? zoomView(z.raw.length, v[0], v[1], frac(e), 1, d > 0 ? 0.1 : -0.1)
        : zoomView(z.raw.length, v[0], v[1], frac(e), d > 0 ? 1.25 : 0.8, 0);
      draw();
    }, { passive: false });
    cv.addEventListener("dblclick", () => { z.v0 = 0; z.v1 = z.raw.length; draw(); });
    const GRAB = 10;
    let end = null, pan = null;
    const zoomed = () => (z.v1 ?? z.raw.length) - (z.v0 ?? 0) < z.raw.length;
    const near = (e) => {
      const r = cv.getBoundingClientRect(), v0 = z.v0 ?? 0, span = (z.v1 ?? z.raw.length) - v0;
      const da = Math.abs(e.clientX - (r.left + (z.a - v0) / span * r.width)), db = Math.abs(e.clientX - (r.left + (z.b - v0) / span * r.width));
      return Math.min(da, db) > GRAB ? null : da <= db ? "a" : "b";
    };
    cv.addEventListener("pointerdown", (e) => {
      if (busy || recActive() || e.button !== 0 || !e.isPrimary || end || pan) return;
      end = near(e);
      if (!end && zoomed()) { pan = { x: e.clientX, v0: z.v0 ?? 0, span: (z.v1 ?? z.raw.length) - (z.v0 ?? 0) }; cv.setPointerCapture(e.pointerId); return; }
      const p = at(e);
      end = end || (Math.abs(p - z.a) <= Math.abs(p - z.b) ? "a" : "b");
      cv.setPointerCapture(e.pointerId);
      move(e);
    });
    const move = (e) => {
      if (pan) {
        const r = cv.getBoundingClientRect(), a = Math.round(pan.v0 - (e.clientX - pan.x) / r.width * pan.span);
        z.v0 = Math.max(0, Math.min(z.raw.length - pan.span, a)); z.v1 = z.v0 + pan.span; draw(); return;
      }
      if (!end) { cv.style.cursor = near(e) || !zoomed() ? "ew-resize" : "grab"; return; }
      const p = at(e);
      if (end === "a") drafts[k].trim(i, p, z.b); else drafts[k].trim(i, z.a, p);
      draw(); fields();
    };
    cv.addEventListener("pointermove", move);
    const done = () => { if (pan) { pan = null; return; } if (!end) return; end = null; drawSlot(k); };
    cv.addEventListener("pointerup", done); cv.addEventListener("pointercancel", done);
    /* START / END in ms: the same trim from the keyboard */
    const num = (label, get, set) => {
      const inp = el("input", { class: "text num", type: "number", min: 0, max: ms(z.raw.length), step: 1, value: ms(get()), "aria-label": `${label} ${i + 1}` });
      inp.addEventListener("change", () => { set(Math.round(+inp.value / 1000 * SMP.RATE)); drawSlot(k); });
      inp.addEventListener("focus", () => help(label, inp.value + " ms"));
      return { inp, sync: () => { if (document.activeElement !== inp) inp.value = ms(get()); } };
    };
    const a = num("START", () => z.a, (v) => drafts[k].trim(i, v, z.b)), b = num("END", () => z.b, (v) => drafts[k].trim(i, z.a, v));
    const fields = () => { a.sync(); b.sync(); };
    requestAnimationFrame(draw);
    return el("div", { class: "trimbox" }, cv,
      el("div", { class: "trimnums" }, el("label", { class: "field sm" }, el("span", { class: "lbl", text: "START ms" }), a.inp),
        el("label", { class: "field sm" }, el("span", { class: "lbl", text: "END ms" }), b.inp)));
  }

  /* ---- recording ---- */
  async function listInputs() { try { inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"); } catch { inputs = []; } }
  async function recStart(k) {
    const d = drafts[k], left = MAX_DATA - d.bytes;
    if (!dev || recActive() || busy) return;
    if (left < 1024 || d.full) { ui.say(t("recFull"), "warn"); return; }
    let stream = null, ctx = null;
    recStarting = true; drawAll();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: recDevice ? { exact: recDevice } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      ctx = new AudioContext();
      await ctx.resume();
      const url = URL.createObjectURL(new Blob([REC_WORKLET], { type: "text/javascript" }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      const node = new AudioWorkletNode(ctx, "felucca-rec"), mute = ctx.createGain();
      mute.gain.value = 0;                            /* pulled by the graph, nothing heard */
      ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);
      rec = { k, ctx, stream, chunks: [], n: 0, max: Math.floor(left * 2 * ctx.sampleRate / SMP.RATE), peak: 0 };
      node.port.onmessage = (e) => {
        const r = rec;
        if (!r || r.ctx !== ctx || r.stopping) return;
        const c = e.data.subarray(0, Math.max(0, r.max - r.n));
        r.chunks.push(c); r.n += c.length;
        for (const v of e.data) r.peak = Math.max(r.peak, Math.abs(v));
        if (r.n >= r.max) recStop();
      };
      await listInputs();
      recStarting = false; drawAll();
      requestAnimationFrame(tick);
    } catch (e) {
      recStarting = false;
      if (rec && rec.ctx === ctx) rec = null;
      if (stream) stream.getTracks().forEach((x) => x.stop());
      if (ctx) ctx.close().catch(() => {});
      ui.say(`${t("recDenied")} ${e.message}`, "warn");
      drawAll();
    }
  }
  function tick() {
    if (!rec) return;
    const box = boxes[rec.k];
    const lv = box && box.querySelector(".reclevel i"), tm = box && box.querySelector(".rectime");
    if (lv) lv.style.width = (Math.min(1, rec.peak) * 100).toFixed(0) + "%";
    if (tm) tm.textContent = `${(rec.n / rec.ctx.sampleRate).toFixed(1)} / ${(rec.max / rec.ctx.sampleRate).toFixed(1)} s`;
    rec.peak *= 0.8;
    requestAnimationFrame(tick);
  }
  async function recStop() {
    const r = rec;
    if (!r || r.stopping) return;
    r.stopping = true;
    r.stream.getTracks().forEach((x) => x.stop());
    await r.ctx.close().catch(() => {});
    if (rec === r) rec = null;
    const x = new Float64Array(Math.min(r.n, r.max));
    let o = 0;
    for (const c of r.chunks) { const n = Math.min(c.length, x.length - o); x.set(c.subarray(0, n), o); o += n; }
    const raw = Float64Array.from(resample(x, r.ctx.sampleRate, SMP.RATE));
    let pk = 0;
    for (const v of raw) pk = Math.max(pk, Math.abs(v));
    if (pk < 1e-4) { ui.say(t("recSilent"), "warn"); drawAll(); return; }
    const d = drafts[r.k];
    if (raw.length > 1 && !d.full) { d.add(`REC ${d.zones.length + 1}`, raw, { root: 60, trim: true }); if (!d.name) d.setName("REC"); }
    drawAll();
  }

  function play(z) {
    try {
      if (preview && preview.src) preview.src.stop();
      preview = preview || { ctx: new AudioContext() };
      preview.ctx.resume().catch(() => {});
      const buf = preview.ctx.createBuffer(1, z.s.length, SMP.RATE), ch = buf.getChannelData(0);
      for (let i = 0; i < z.s.length; i++) ch[i] = z.s[i] / 32768;
      preview.src = preview.ctx.createBufferSource();
      preview.src.buffer = buf; preview.src.connect(preview.ctx.destination); preview.src.start();
    } catch { /* no audio output */ }
  }

  async function addFiles(k, list) {
    const d = drafts[k];
    for (const f of list) {
      if (d.full) break;
      try { d.add(f.name, await decodeAudio(await f.arrayBuffer(), browserDecode)); }
      catch (e) { ui.say(`${f.name}: ${e.message}`, "warn"); }
    }
    drawSlot(k);
  }

  async function write(k) {
    const d = drafts[k];
    let built;
    try { built = d.build(); } catch (e) { ui.say(e.message, "warn"); return; }
    if (!(await ui.confirm(`WRITE USR${k + 1}?`))) return;
    busy = true; drawAll();
    const bar = boxes[k] && boxes[k].querySelector(".wprog i");
    try {
      const ok = await dev.smpWrite(k, built, (n, total) => { if (bar) bar.style.width = (n / total * 100).toFixed(1) + "%"; $msg(`USR${k + 1} ${kib(n)} / ${kib(total)} KiB`); });
      if (ok) ui.say(`USR${k + 1} ${d.name}`);
    } finally { busy = false; drawAll(); }
  }
  const $msg = (s) => ui.progress && ui.progress(s);

  /* PIANO HD (1.4: the built-in PIANO is lo-fi now): the 1.0 .. 1.1.5 piano as a user slot, from the files beside the
     page (samples/, pinned here), written as they are (never through the WAV import: it would re-encode them); then
     the selected track's SET (GRAIN: SRC) may take that slot */
  const PIANO_HD = { hdr: ["samples/PIANO_HD.hdr", 480, "8c6fdbd42451dcc800c5bb279b0ec377ce0037ef82346e880b26c9a537a3943b"],
    data: ["samples/PIANO_HD.bin", 41345, "b7bccd33344686cb5abe692bb2d85a34d0d9f27452e7e3e658d9d962d8b8d765"] };
  async function pinnedFile([url, size, sha]) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const b = new Uint8Array(await r.arrayBuffer());
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
    if (b.length !== size || hex !== sha) throw new Error(`${url}: not the expected file`);
    return b;
  }
  async function pianoHd(k) {
    const u = dev.smp.slots[k];
    if (!(await ui.confirm(u.zones ? `PIANO HD → USR${k + 1} (${t("overwrite")} ${u.name || "—"})?` : `PIANO HD → USR${k + 1}?`))) return;
    let files;
    try { files = { hdr: await pinnedFile(PIANO_HD.hdr), data: await pinnedFile(PIANO_HD.data) }; } catch (e) { ui.say(e.message, "warn"); return; }
    busy = true; drawAll();
    const bar = boxes[k] && boxes[k].querySelector(".wprog i");
    let ok = false;
    try {
      ok = await dev.smpWrite(k, files, (n, total) => { if (bar) bar.style.width = (n / total * 100).toFixed(1) + "%"; $msg(`USR${k + 1} ${kib(n)} / ${kib(total)} KiB`); });
    } finally { busy = false; drawAll(); }
    if (!ok) return;
    ui.say(`USR${k + 1} PIANO HD`);
    /* the selected track plays SAMPLE or GRAIN: its SET / SRC to that slot, if asked */
    const pe0 = dev.info.pe0, id = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => pe0 + i).find((i) => dev.pdesc[i] && ["SET", "SRC"].includes(dev.pdesc[i].label)
      && (dev.pdesc[i].names || []).includes(`USR${k + 1}`));
    if (id == null || !["SAMPLE", "GRAIN"].includes(dev.engineName())) return;
    const d = dev.pdesc[id], v = d.min + d.names.indexOf(`USR${k + 1}`);
    if (dev.dump.p[id] !== v && (await ui.confirm(`${t("track")} ${(dev.sel ?? 0) + 1}: ${d.label} → USR${k + 1}?`))) dev.setParam(0, id, v);
  }

  /* ---- a slot ---- */
  function slot(k) {
    const u = dev.smp.slots[k], d = drafts[k], on = rec && rec.k === k;
    const file = el("input", { type: "file", accept: ".wav,audio/wav,audio/x-wav,audio/*", multiple: true, hidden: true });
    file.addEventListener("change", () => { addFiles(k, [...file.files]); file.value = ""; });
    const name = el("input", { class: "text", type: "text", maxlength: NAME_MAX, value: d.name, spellcheck: "false", placeholder: "NAME", "aria-label": `USR${k + 1} NAME` });
    name.addEventListener("input", () => { const v = cleanName(name.value); if (v !== name.value) name.value = v; d.setName(v); drawActs(); });
    const inputSel = el("select", { "aria-label": t("recInput"), disabled: !!rec },
      el("option", { value: "", text: t("recInput") }), ...inputs.map((x, i) => el("option", { value: x.deviceId, text: x.label || `${t("recInput")} ${i + 1}` })));
    inputSel.value = recDevice;
    inputSel.addEventListener("change", () => { recDevice = inputSel.value; });
    const acts = el("div", { class: "acts wrap" });
    const drawActs = () => put(acts, 
      el("button", { type: "button", class: "btn", disabled: busy || recActive() || d.full, onclick: () => file.click() }, ic("symbol_folder_open"), t("files")),
      el("button", { type: "button", class: "btn" + (on ? " recon" : ""), disabled: busy || recStarting || (!!rec && (!on || rec.stopping)), onclick: () => (on ? recStop() : recStart(k)) },
        ic(on ? "control_stop_f" : "control_rec_f"), on ? "STOP" : "REC"),
      el("button", { type: "button", class: "btn primary", disabled: busy || recActive() || !d.zones.length || d.tooBig || !d.name, onclick: () => write(k) }, ic("symbol_upload"), "WRITE"),
      d.zones.length ? el("button", { type: "button", class: "btn", disabled: busy || recActive(), onclick: () => { d.clear(); drawSlot(k); } }, ic("symbol_trash"), "CLEAR") : null);
    drawActs();
    const keys = d.keys;
    const zones = d.zones.map((z, i) => {
      const rootIn = el("input", { class: "text root", type: "text", value: noteName(z.root), spellcheck: "false", "aria-label": `ROOT ${i + 1}` });
      rootIn.addEventListener("change", () => { const n = parseNote(rootIn.value.trim()); if (n == null) { rootIn.classList.add("bad"); return; } d.setRoot(i, n); drawSlot(k); });
      return el("div", { class: "zone", role: "group", "aria-label": z.fname },
        el("div", { class: "zhead" },
          el("span", { class: "nm", text: z.fname }),
          el("label", { class: "field sm" }, el("span", { class: "lbl", text: "ROOT" }), rootIn),
          el("span", { class: "lbl", text: `${noteName(keys[i][0])}–${noteName(keys[i][1])}` }),
          el("span", { class: "lbl", text: `${(z.s.length / SMP.RATE).toFixed(2)} s` }),
          el("span", { class: "rowacts" },
            el("button", { type: "button", class: "iconbtn sm", "aria-label": `▶ ${z.fname}`, onclick: () => play(z) }, ic("control_play_f")),
            el("button", { type: "button", class: "btn sm", disabled: busy || recActive(), onclick: () => { d.autoTrim(i); drawSlot(k); } }, "AUTO"),
            el("button", { type: "button", class: "iconbtn sm", "aria-label": `× ${z.fname}`, disabled: busy || recActive(), onclick: () => { d.remove(i); drawSlot(k); } }, ic("symbol_cross")))),
        trimView(k, i));
    });
    const c = card(`USR${k + 1}`, "symbol_audio",
      el("div", { class: "slothead" },
        el("b", { text: u.zones ? u.name || "—" : t("empty") }),
        el("span", { class: "lbl", text: u.zones ? `${u.zones} ZONES · ${u.kib} KiB` : "" }),
        dev.info.motionCap ? el("button", { type: "button", class: "btn sm", disabled: busy || recActive(), onclick: () => pianoHd(k) }, ic("symbol_download"), "PIANO HD") : null,
        el("button", { type: "button", class: "btn sm", disabled: busy || !u.zones, onclick: async () => { if (await ui.confirm(`ERASE USR${k + 1}?`)) { busy = true; drawAll(); try { await dev.smpErase(k); } finally { busy = false; drawAll(); } } } }, ic("symbol_trash"), t("erase"))),
      el("div", { class: "meter", role: "img", "aria-label": `${u.kib} / ${dev.smp.slotKiB} KiB` }, el("i", { style: `width:${(u.kib / dev.smp.slotKiB * 100).toFixed(1)}%` })),
      el("div", { class: "draft" },
        el("label", { class: "field" }, el("span", { class: "lbl", text: "NAME" }), name),
        el("div", { class: "drafthead" },
          el("span", { class: d.tooBig ? "lbl over" : "lbl", text: d.zones.length ? `${kib(d.bytes)} / ${kib(MAX_DATA)} KiB · ${d.zones.length} / ${SMP.MAX_ZONES}` : "" }),
          on ? el("span", { class: "reclevel" }, el("i")) : null, on ? el("span", { class: "lbl rectime" }) : null,
          inputs.length ? el("label", { class: "pick sel" }, el("span", { class: "lbl", text: "IN" }), el("b", { text: (inputs.find((x) => x.deviceId === recDevice) || {}).label || "—" }), inputSel) : null),
        acts, busy ? el("div", { class: "meter wprog" }, el("i", { style: "width:0" })) : null,
        ...zones), file);
    c.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); c.classList.add("over"); } });
    c.addEventListener("dragleave", () => c.classList.remove("over"));
    c.addEventListener("drop", (e) => { e.preventDefault(); c.classList.remove("over"); if (!busy && !recActive() && e.dataTransfer.files.length) addFiles(k, [...e.dataTransfer.files]); });
    return c;
  }
  function drawSlot(k) {
    if (!dev || !dev.smp || !boxes[k]) return drawAll();
    const n = slot(k);
    boxes[k].replaceWith(n);
    boxes[k] = n;
  }
  function drawAll() {
    boxes.length = 0;
    if (!dev || !dev.smp) { root.replaceChildren(); return; }
    for (let k = 0; k < dev.smp.nslots; k++) boxes.push(slot(k));
    root.replaceChildren(el("div", { class: "grid samples" }, ...boxes));
  }
  /* leaving (another place, disconnected): a recording stops (it stays in the draft), the preview closes */
  function leave() {
    recStarting = false;
    if (rec) recStop();
    if (preview) { try { preview.src && preview.src.stop(); } catch { /* ended */ } preview.ctx.close().catch(() => {}); preview = null; }
  }
  return {
    show(device) { if (device !== dev) leave(); dev = device && device.loaded ? device : null; drawAll(); },
    refresh() { if (!busy) drawAll(); },
    leave,
  };
}
