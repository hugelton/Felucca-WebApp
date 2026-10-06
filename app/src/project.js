// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// PROJECT: the device's four projects A..D (load, save), the song chain (rows of a project and its repeats, PLAY /
// STOP, where it is), and the full backup to a file and back.

import { F } from "./proto.js";
import { el, ic } from "./dom.js";
import { card, paramRow } from "./parts.js";
import { t } from "./text.js";

const L = (k) => String.fromCharCode(65 + k);       /* the device names projects A..D */
const MAX_BACKUP = 600000;

export function projectScreen(root, ui) {
  let dev = null, busy = false;
  const restoreInput = el("input", { type: "file", accept: ".json,application/json", hidden: true });
  restoreInput.addEventListener("change", async () => {
    const f = restoreInput.files[0];
    restoreInput.value = "";
    if (!f || !dev) return;
    if (f.size > MAX_BACKUP) { ui.say(`${f.name}: ${t("tooLarge")}`, "warn"); return; }
    let archive;
    try { archive = dev.backupCheck(await f.text()); } catch (e) { ui.say(`${f.name}: ${e.message}`, "warn"); return; }
    if (!(await ui.confirm("RESTORE ALL?"))) return;
    run(() => dev.backupRestore(archive, (n, total) => ui.progress(`BACKUP ${Math.round(n / Math.max(1, total) * 100)}%`)),
      (ok) => { if (ok) ui.say(`${t("restored")} ${f.name}`); });
  });

  async function run(fn, done) {
    if (busy) return;
    busy = true; draw();
    try { const r = await fn(); if (done) done(r); } finally { busy = false; draw(); }
  }

  function projects() {
    const slots = dev.slotUsed.map((u, k) => el("div", { class: "slot" + (u ? "" : " empty"), role: "group", "aria-label": `PROJECT ${L(k)}` },
      el("span", { class: "big", text: L(k) }),
      el("span", { class: "lbl", text: u == null ? "—" : u ? t("saved") : t("empty") }),
      el("div", { class: "acts" },
        el("button", { type: "button", class: "btn", disabled: busy || !u, onclick: async () => {
          if (!(await ui.confirm(`LOAD ${L(k)}?`))) return;
          run(() => dev.project(0, k), (r) => { if (r) ui.say(r.used ? `${t("loaded")} ${L(k)}` : `${L(k)} ${t("empty")}`); });
        } }, ic("symbol_folder_open"), t("load")),
        el("button", { type: "button", class: "btn", disabled: busy, onclick: async () => {
          if (!(await ui.confirm(u ? `SAVE TO ${L(k)}?` : `SAVE ${L(k)}?`))) return;
          run(() => dev.project(1, k), (r) => { if (r) ui.say(`${t("saved")} ${L(k)}`); });
        } }, ic("symbol_download_as"), t("save")))));
    return el("section", { class: "card wide" }, el("h2", {}, ic("symbol_folder_open"), el("span", { text: "PROJECTS" })), el("div", { class: "slots" }, ...slots));
  }

  function song() {
    const s = dev.song;
    if (!dev.info.chainRows || !s) return null;
    const play = !!s.playing;
    const set = (rows) => run(() => dev.songOp(1, rows), (r) => { if (r) ui.say("SONG"); });
    const rows = s.rows.map((r, i) => {
      const pick = el("select", { "aria-label": `SONG ${i + 1}`, disabled: play || busy },
        ...[0, 1, 2, 3].map((k) => el("option", { value: k, text: `${L(k)}${dev.slotUsed[k] ? "" : " · " + t("empty")}` })));
      pick.value = String(r.slot);
      pick.addEventListener("change", () => set(s.rows.map((x, j) => (j === i ? { ...x, slot: +pick.value } : { ...x }))));
      const reps = paramRow({ fmt: F.INT, min: 1, max: 16, def: 1, label: "×", unit: "" }, r.repeat,
        (v, final) => { if (final) set(s.rows.map((x, j) => (j === i ? { ...x, repeat: v } : { ...x }))); }, { label: `× ${i + 1}` });
      return el("div", { class: "songrow" + (play && s.row === i ? " at" : "") },
        el("span", { class: "n", text: String(i + 1) }),
        el("label", { class: "pick sel" }, el("span", { class: "lbl", text: "PROJECT" }), el("b", { text: L(r.slot) }), pick),
        reps.el,
        el("button", { type: "button", class: "iconbtn sm", "aria-label": `SONG ${i + 1} ×`, disabled: play || busy,
          onclick: () => set(s.rows.filter((_, j) => j !== i).map((x) => ({ ...x }))) }, ic("symbol_cross")));
    });
    const c = card("SONG", "control_arrow_loop",
      el("div", { class: "rows" }, ...rows),
      el("div", { class: "acts wrap" },
        el("button", { type: "button", class: "btn primary", disabled: busy || (!play && !s.rows.length), onclick: () => run(() => dev.songOp(play ? 3 : 2)) },
          ic(play ? "control_stop_f" : "control_play_f"), play ? "STOP" : "PLAY"),
        el("button", { type: "button", class: "btn", disabled: play || busy || s.rows.length >= 16,
          onclick: () => set([...s.rows.map((x) => ({ ...x })), { slot: s.rows.length ? s.rows[s.rows.length - 1].slot : 0, repeat: 1 }]) }, ic("control_add"), "ROW")));
    c.aside.textContent = play ? `${s.row + 1} / ${s.count} · ×${s.remaining}` : `${s.rows.length} / 16`;
    return c;
  }

  function backup() {
    const caps = dev.backupCaps();
    if (!caps) return null;
    return card("BACKUP", "symbol_disc",
      el("div", { class: "acts wrap" },
        el("button", { type: "button", class: "btn primary", disabled: busy || !(caps & 1), onclick: () => run(
          () => dev.backupSave((n, total) => ui.progress(`BACKUP ${Math.round(n / Math.max(1, total) * 100)}%`)),
          (file) => { if (file) { ui.download(`Felucca-backup-${new Date().toISOString().slice(0, 10)}.json`, file); ui.say(t("backupSaved")); } }) },
        ic("symbol_download"), t("save")),
        el("button", { type: "button", class: "btn", disabled: busy || !(caps & 2), onclick: () => restoreInput.click() }, ic("symbol_upload"), t("restore"))),
      restoreInput);
  }

  function draw() {
    if (!dev) { root.replaceChildren(); return; }
    if (root.contains(document.activeElement) && document.activeElement.tagName === "SELECT") return;
    root.replaceChildren(el("div", { class: "grid" }, ...[projects(), song(), backup()].filter(Boolean)));
  }
  return {
    show(device) { dev = device && device.loaded ? device : null; draw(); },
    refresh() { if (!busy) draw(); },
  };
}
