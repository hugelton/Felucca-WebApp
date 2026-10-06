// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// The page: the frame (header, tracks, flash, places, help bar, messages, dialogs), the connection and its
// events, and the screens. ?mock=1 drives everything against the simulated device (&legacy=1: no live sync).

import { makeMockDevice } from "./proto.js";
import { Device } from "./device.js";
import { $, $$, el, icons, store } from "./dom.js";
import { onHelp } from "./parts.js";
import { soundScreen } from "./sound.js";
import { seqScreen } from "./seq.js";
import { mixScreen } from "./mix.js";
import { Library, indexedStore, memoryStore } from "./library.js";
import { libraryScreen } from "./libview.js";
import { samplesScreen } from "./sampview.js";
import { projectScreen } from "./project.js";
import { cells } from "./parts.js";
import { applyEditorPrefs, settingsScreen } from "./settings.js";
import { t } from "./text.js";

const QS = new URLSearchParams(location.search);
const MOCK = QS.get("mock") === "1";
const PLACES = [["sound", "waveform_variant"], ["seq", "symbol_grid"], ["mix", "ui_slider_vertical"], ["library", "symbol_books"], ["project", "symbol_folder_open"]];
const PLACE_KEY = "felucca-editor-place";

let access = null, dev = null, wantConnected = false, connecting = false;
let place = PLACES.some(([p]) => p === store.get(PLACE_KEY)) ? store.get(PLACE_KEY) : "sound", inSettings = false;

/* ---- messages: the log, and its last line at the right of the help bar ---- */
const messages = [];
function say(text, level = "info") {
  const now = new Date();
  messages.unshift({ time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`, text, level });
  messages.length = Math.min(messages.length, 100);
  $("#msg-t").textContent = text;
  $("#msgs").classList.toggle("warn", level !== "info");
  if ($("#log").open) drawLog();
}
const sayK = (k, extra = "", level) => say(t(k) + (extra ? " " + extra : ""), level || (["error", "noreply", "lost", "nodevice", "denied", "nomidi", "rejected"].includes(k) ? "warn" : "info"));
function drawLog() { $("#log-list").replaceChildren(...messages.map((m) => el("li", {}, el("time", { text: m.time }), el("span", { class: m.level === "info" ? null : "warn", text: m.text })))); }

/* ---- the help bar: the name of what was touched and its value ---- */
onHelp((name, value) => $("#help").replaceChildren(el("b", { text: name }), value ? document.createTextNode("  " + value) : ""));

/* ---- dialogs ---- */
function confirmDialog(title) {
  const d = $("#confirm");
  $("#cf-t").textContent = title;
  return new Promise((resolve) => {
    const done = (v) => { d.close(); $("#cf-yes").onclick = $("#cf-no").onclick = null; d.oncancel = null; resolve(v); };
    $("#cf-yes").onclick = () => done(true); $("#cf-no").onclick = () => done(false); d.oncancel = () => done(false);
    d.showModal(); $("#cf-no").focus();
  });
}

function askDialog(title, value = "") {
  const d = $("#ask"), input = $("#ak-v");
  $("#ak-t").textContent = title; input.value = value;
  return new Promise((resolve) => {
    const done = (v) => { d.close(); $("#ak-f").onsubmit = $("#ak-no").onclick = d.oncancel = null; resolve(v); };
    $("#ak-f").onsubmit = (e) => { e.preventDefault(); done(input.value); };
    $("#ak-no").onclick = () => done(null); d.oncancel = () => done(null);
    d.showModal(); input.focus(); input.select();
  });
}
/* a file to save: JSON from an object, or bytes */
function download(name, data, type = "application/json") {
  const blob = new Blob([data instanceof Uint8Array ? data : JSON.stringify(data, null, 1)], { type });
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---- screens ---- */
const ui = {
  confirm: confirmDialog,
  ask: askDialog,
  download,
  say: (text, level = "info") => say(text, level),
  progress: (text) => { $("#msg-t").textContent = text; },
  changed: (s, id, v) => { if (s === 0 && dev) { drawTracks(); seq.param(s, id, v); } },
  prefResult: (rc) => { if (rc === 4) sayK("pending"); else if (rc === 3) sayK("unsaved"); else if (rc) sayK("rejected"); },
  relabel: () => { relabel(); renderAll(); },
};
const sound = soundScreen($("#s-sound"), ui);
const settings = settingsScreen($("#s-settings"), ui);
const seq = seqScreen($("#s-seq"), ui);
const mix = mixScreen($("#s-mix"));
const lib = new Library(typeof indexedDB === "undefined" ? memoryStore() : indexedStore());
/* LIBRARY: SOUNDS (presets, the library, the user bank) or SAMPLES (the three user sample slots) */
const LIBTAB_KEY = "felucca-editor-libtab";
const libSounds = el("div"), libSamples = el("div");
let libTab = store.get(LIBTAB_KEY) === "samples" ? 1 : 0;
function showLibTab(i) { libTab = i; store.set(LIBTAB_KEY, i ? "samples" : "sounds"); libSounds.hidden = !!i; libSamples.hidden = !i; if (!i) samples.leave(); }
$("#s-library").replaceChildren(el("div", { class: "subtabs" }, cells(["SOUNDS", "SAMPLES"], libTab, showLibTab, t("library")).el), libSounds, libSamples);
const library = libraryScreen(libSounds, ui, lib);
const samples = samplesScreen(libSamples, ui);
const project = projectScreen($("#s-project"), ui);
showLibTab(libTab);
lib.init();
function renderAll() {
  sound.show(dev && dev.loaded ? dev : null);
  seq.show(dev && dev.loaded ? dev : null);
  mix.show(dev && dev.loaded ? dev : null);
  library.show(dev && dev.loaded ? dev : null);
  samples.show(dev && dev.loaded ? dev : null);
  project.show(dev && dev.loaded ? dev : null);
  settings.show(dev && dev.loaded ? dev : null);
  drawTracks(); drawStore(); drawState();
}

/* ---- places and settings ---- */
function go(name) {
  if (name !== "library") samples.leave();
  place = name; inSettings = false;
  $("#settings").setAttribute("aria-pressed", "false");
  for (const [p] of PLACES) { const b = $("#t-" + p); b.setAttribute("aria-selected", String(p === name)); b.tabIndex = p === name ? 0 : -1; }
  for (const s of $$(".screen")) s.hidden = s.id !== "s-" + name;
  store.set(PLACE_KEY, name);
}
function openSettings(on) {
  inSettings = on;
  $("#settings").setAttribute("aria-pressed", String(on));
  if (!on) return go(place);
  for (const b of $$(".place")) b.setAttribute("aria-selected", "false");
  for (const s of $$(".screen")) s.hidden = s.id !== "s-settings";
}
$("#rail").replaceChildren(...PLACES.map(([p, icon], n) => el("button", {
  type: "button", class: "place", role: "tab", id: "t-" + p, "aria-controls": "s-" + p,
  onclick: () => go(p),
  onkeydown: (e) => {
    const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const q = PLACES[(n + dir + PLACES.length) % PLACES.length][0];
    go(q); $("#t-" + q).focus();
  },
}, el("span", { "data-i": icon }), el("span", { "data-t": p }))));
$("#settings").onclick = () => openSettings(!inSettings);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && inSettings && !document.querySelector("dialog[open]")) openSettings(false); });
$("#theme").onclick = () => {
  const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark");
  store.set("felucca-editor-theme", dark ? "light" : "dark");
  applyEditorPrefs();
  settings.show(dev && dev.loaded ? dev : null);
};
$("#msgs").onclick = () => { drawLog(); $("#log").showModal(); };
$("#lg-x").onclick = () => $("#log").close();
$("#store").onclick = () => $("#storage").showModal();
$("#sg-x").onclick = () => $("#storage").close();

/* static labels: data-t, and the aria-labels of the icon buttons */
function relabel() {
  for (const e of $$("[data-t]")) e.textContent = t(e.dataset.t);
  $("#theme").setAttribute("aria-label", t("display"));
  $("#settings").setAttribute("aria-label", t("settings"));
  $("#installer").setAttribute("aria-label", t("installer"));
  $("#rail").setAttribute("aria-label", t("sound") + " · " + t("seq"));
  $("#tracks").setAttribute("aria-label", t("tracks"));
  $("#connect").lastElementChild.textContent = t(dev ? "disconnect" : "connect");
}

/* ---- header: state, tracks, flash ---- */
function drawState() {
  const on = dev && dev.loaded;
  $("#state-t").textContent = on ? `${dev.watch ? t("live") : t("polling")} · ${dev.info.version.replace(/^FELUCCA\s*/i, "")}` : t("offline");
  $("#state-dot").classList.toggle("off", !on);
}
function drawTracks() {
  const n = dev && dev.loaded ? dev.info.ntrk || 0 : 0, box = $("#tracks");
  box.replaceChildren(...Array.from({ length: n }, (_, i) => {
    const x = dev.mix && dev.mix.tracks[i];
    const name = x ? [dev.info.engines[x.engine], (dev.names[x.engine] || [])[x.preset]].filter(Boolean).join(" ") : "";
    return el("button", {
      type: "button", class: "trk", role: "radio", "aria-checked": String(i === dev.sel), "aria-label": `${t("track")} ${i + 1}${name ? ": " + name : ""}`,
      onclick: () => { if (dev && i !== dev.sel) dev.selectTrack(i); },
    }, el("span", { class: "cush", "aria-hidden": "true", text: String(i + 1) }));
  }));
}
function drawStore() {
  const s = dev && dev.loaded ? dev.storage() : null, btn = $("#store");
  btn.hidden = !s || !s.samples.length;
  if (btn.hidden) return;
  const tot = s.slotKiB * s.samples.length, used = s.samples.reduce((a, x) => a + x.kib, 0), free = tot - used;
  $("#store-bar").style.width = (tot ? used / tot * 100 : 0).toFixed(1) + "%";
  $("#store-t").textContent = `${free} KiB ${t("free")}`;
  btn.classList.toggle("low", free < s.slotKiB / 4);
  btn.setAttribute("aria-label", `${t("flash")}: ${free} / ${tot} KiB ${t("free")}`);
  const row = (name, val, frac) => el("div", { class: "st-row" }, el("span", { class: "lbl", text: name }), el("span", { text: val }),
    el("div", { class: "meter", role: "img", "aria-label": `${name}: ${val}` }, el("i", { style: `width:${(frac * 100).toFixed(1)}%` })));
  $("#sg-rows").replaceChildren(
    ...s.samples.map((x) => row(`USR${x.slot + 1}${x.name ? " · " + x.name : ""}`, x.kib ? `${x.kib} / ${s.slotKiB} KiB` : t("empty"), x.kib / (s.slotKiB || 1))),
    ...(s.presets ? [row(t("presetsU"), `${s.presets[0]} / ${s.presets[1]}`, s.presets[0] / s.presets[1])] : []),
    row(t("projects"), `${s.projects[0]} / ${s.projects[1]}`, s.projects[0] / s.projects[1]),
    ...(s.fm6 ? [row(t("fm6bank"), `${s.fm6[0]} / ${s.fm6[1]}`, s.fm6[0] / s.fm6[1])] : []));
}

/* ---- the connection ---- */
async function connect() {
  if (connecting || dev) return;
  connecting = true; wantConnected = true;
  $("#connect").disabled = true;
  try {
    if (!access) {
      if (MOCK) access = makeMockDevice({ legacy: QS.get("legacy") === "1" }).access;
      else if (!navigator.requestMIDIAccess) { sayK("nomidi"); return; }
      else { try { access = await navigator.requestMIDIAccess({ sysex: true }); } catch { sayK("denied"); return; } }
      access.onstatechange = onPortState;
    }
    sayK("connecting");
    const d = new Device(access, { hidden: () => document.hidden });
    dev = d;
    relabel();
    d.on("progress", (p) => { if (p.what === "desc") $("#msg-t").textContent = `${t("reading")} ${p.n}/${p.total}`; else if (p.what === "steps") $("#msg-t").textContent = `${t("steps")} ${p.n}/${p.total}`; });
    d.on("param", (p) => { sound.param(p.scope, p.id, p.value); seq.param(p.scope, p.id, p.value); settings.param(p.scope, p.id, p.value); });
    const settle = () => { $("#msg-t").textContent = messages.length ? messages[0].text : ""; };   /* (the progress line goes) */
    d.on("reload", () => { sound.show(d); seq.show(d); mix.show(d); library.refresh(); samples.refresh(); project.refresh(); settings.show(d); drawTracks(); drawStore(); drawState(); settle(); });
    d.on("mix", () => { drawTracks(); if (d.loaded) mix.all(); });
    d.on("track", (k) => { drawTracks(); mix.track(k); });
    d.on("step", (k) => seq.step(k));
    d.on("steps", () => { seq.steps(); settle(); });
    d.on("motion", () => seq.motion());
    d.on("live", () => drawState());
    d.on("preferences", () => { if (d.loaded) { settings.show(d); library.refresh(); } });
    d.on("bank", () => { if (d.loaded) library.refresh(); });
    d.on("storage", () => drawStore());
    d.on("samples", () => samples.refresh());
    d.on("projects", () => project.refresh());
    d.on("song", () => project.refresh());
    d.on("error", (e) => sayK(e.message === "noreply" ? "noreply" : "error", e.message === "noreply" ? "" : e.message));
    d.on("closed", (reason) => { if (dev === d) { dev = null; renderAll(); relabel(); sayK(reason); } });
    await d.open();
    if (dev !== d) return;
    await lib.adopt(d);
    renderAll();
    sayK("ready", d.info.version);
  } catch (e) {
    const d = dev;
    if (d) { dev = null; d.close(e.message === "nodevice" ? "nodevice" : /^timeout/.test(e.message) ? "noreply" : "error"); }
    else if (e.message === "nodevice") sayK("nodevice");
    if (e.message !== "nodevice" && !/^timeout/.test(e.message)) console.error(e);
  } finally {
    connecting = false;
    $("#connect").disabled = false;
    relabel();
  }
}
function disconnect(reason = "disconnected") { wantConnected = false; if (dev) dev.close(reason); }
$("#connect").onclick = () => (dev ? disconnect() : connect());
function onPortState(e) {
  const p = e.port;
  if (!p || !/felucca/i.test(p.name || "")) return;
  if (dev && p.state === "disconnected" && dev.input && (p.id === dev.input.id || p.id === dev.output.id)) dev.close("lost");
  else if (!dev && wantConnected && p.state === "connected" && p.type === "output") {
    clearTimeout(onPortState.tm);                    /* the device came back: connect again */
    onPortState.tm = setTimeout(() => { if (!dev && wantConnected) connect(); }, 800);
  }
}
/* MOTION is not pushed: read it while the sequence shows */
setInterval(() => { if (dev && dev.loaded && place === "seq" && !inSettings) dev.pollMotion(); }, 1500);
/* nor is the song: read it while PROJECT shows */
setInterval(() => { if (dev && dev.loaded && place === "project" && !inSettings) dev.pollSong(); }, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && dev) dev.visible(); });

/* ---- start ---- */
applyEditorPrefs();
icons();
relabel();
go(place);
renderAll();
sayK("offline");
/* icons stay hidden until the font has loaded (no boxes); from file:// or on failure, words only */
document.fonts && document.fonts.load('16px "Fukiai"').then(() => { if (document.fonts.check('16px "Fukiai"')) document.documentElement.classList.add("fk"); }).catch(() => {});
if (MOCK) connect();
