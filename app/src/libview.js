// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// LIBRARY: the device's presets (favourites: ALL / FAV, a star each), the library kept in this browser, and the
// device's user bank. Lists are listboxes (arrows move, Enter loads or auditions); a library sound goes to a slot
// and a slot to the library by a button or by dragging it across.

import { devicePresetRows, engineLabel, engineOrder } from "./proto.js";
import { $$, ENGINE_IC, el, ic } from "./dom.js";
import { SORTS, fileSlug, slotName, today } from "./library.js";
import { card, cells, help } from "./parts.js";
import { t } from "./text.js";

/* a listbox: rows [{key, cells: [...nodes], drag, drop}], selected key; arrows move, Enter = onEnter */
function listbox(label, rows, sel, { onSelect, onEnter, onKey } = {}) {
  const box = el("ul", { class: "list", role: "listbox", "aria-label": label, tabindex: rows.length ? null : "0" });
  const items = rows.map((r, i) => {
    const li = el("li", { class: "item" + (r.dim ? " dim" : ""), role: "option", "aria-selected": String(r.key === sel), tabindex: r.key === sel || (sel == null && i === 0) ? "0" : "-1",
      draggable: r.drag ? "true" : null, "data-key": String(r.key),
      onclick: () => onSelect && onSelect(r.key),
      ondblclick: () => onEnter && onEnter(r.key),
      onkeydown: (e) => {
        const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
        if (d) { e.preventDefault(); const n = rows[Math.max(0, Math.min(rows.length - 1, i + d))]; if (n) { onSelect && onSelect(n.key); requestAnimationFrame(() => { const x = box.querySelector(`[data-key="${CSS.escape(String(n.key))}"]`); if (x) x.focus(); }); } }
        else if (e.key === "Enter") { e.preventDefault(); onEnter && onEnter(r.key); }
        else if (onKey) onKey(e, r.key);
      },
      onfocus: () => help(label, r.name || ""),
    }, ...r.cells);
    if (r.drag) li.addEventListener("dragstart", (e) => { e.dataTransfer.setData(r.drag[0], r.drag[1]); e.dataTransfer.effectAllowed = "copy"; });
    if (r.drop) {
      li.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes(r.drop[0])) { e.preventDefault(); li.classList.add("over"); } });
      li.addEventListener("dragleave", () => li.classList.remove("over"));
      li.addEventListener("drop", (e) => { e.preventDefault(); li.classList.remove("over"); const v = e.dataTransfer.getData(r.drop[0]); if (v) r.drop[1](v); });
    }
    return li;
  });
  box.append(...items);
  return box;
}
const pickRow = (label, value, options, onchange) => {
  const sel = el("select", { "aria-label": label }, ...options.map(([v, txt]) => el("option", { value: v, text: txt })));
  sel.value = value;
  const shown = el("b", { text: (options.find(([v]) => v === value) || options[0] || ["", ""])[1] });
  sel.addEventListener("change", () => { shown.textContent = sel.selectedOptions[0] ? sel.selectedOptions[0].text : ""; onchange(sel.value); });
  return el("label", { class: "pick sel" }, el("span", { class: "lbl", text: label }), shown, sel);
};
const btn = (icon, text, onclick, disabled = false, primary = false) =>
  el("button", { type: "button", class: "btn" + (primary ? " primary" : ""), disabled, onclick }, icon ? ic(icon) : null, text);

export function libraryScreen(root, ui, lib) {
  let dev = null, libSel = null, bankSel = null, view = { q: "", engine: "", tag: "", sort: "modified" }, presetSel = null, busy = false;
  const fileInput = el("input", { type: "file", accept: ".json,application/json", multiple: true, hidden: true });
  fileInput.addEventListener("change", async () => {
    const files = await Promise.all([...fileInput.files].map(async (f) => ({ name: f.name, text: await f.text() })));
    fileInput.value = "";
    const r = await lib.importFiles(files, dev);
    ui.say(`${t("imported")} ${r.added}${r.skipped ? ` (${r.skipped} ${t("skipped")})` : ""}`);
    for (const [name, msg] of r.errors) ui.say(`${name}: ${msg}`, "warn");
  });

  /* runs one device operation with the buttons off; reports its error */
  async function run(fn, done) {
    if (busy) return;
    busy = true; draw();
    try { const r = await fn(); if (done) done(r); } finally { busy = false; draw(); }
  }

  /* ---- PRESETS: the device's, with favourites ---- */
  function presets() {
    const p = dev.preferences;
    if (!p || !(p.state.caps & 8)) return null;
    const rows = devicePresetRows(dev.info, dev.names, p);
    const key = (r) => `${r.engine}:${r.preset}`;
    const load = (k) => { const r = rows.find((x) => key(x) === k); if (!r || busy) return; run(() => (r.user ? dev.bankLoad(r.preset) : dev.loadPreset(r.engine, r.preset)), () => ui.say(`${t("loaded")} ${r.name}`)); };
    const items = rows.map((r) => ({
      key: key(r), name: r.name,
      cells: [el("span", { class: "tag", text: r.user ? slotName(r.preset) : dev.info.engines[r.engine] }), el("span", { text: r.name }),
        el("span", { class: "rowacts" },
          r.user ? null : el("button", { type: "button", class: "iconbtn sm", "aria-label": `${t("keep")}: ${r.name}`, disabled: busy,
            onclick: (e) => { e.stopPropagation(); run(() => dev.captureFactory(r.engine, r.preset), async (pt) => { if (pt) { await lib.add([pt]); ui.say(`${t("kept")} ${pt.name}`); } }); } }, ic("symbol_download_as")),
          el("button", { type: "button", class: "iconbtn sm star" + (r.favorite ? " on" : ""), "aria-pressed": String(r.favorite), "aria-label": `FAV: ${r.name}`, disabled: busy,
            onclick: (e) => { e.stopPropagation(); run(() => dev.favorite(r, !r.favorite), (rc) => ui.prefResult(rc)); } }, ic(r.favorite ? "symbol_star" : "symbol_star_o")))],
    }));
    const c = card("PRESETS", "symbol_star",
      el("div", { class: "enum" }, cells(["ALL", "FAV"], p.state.filter ? 1 : 0, (i) => run(() => dev.changePreference(3, i), (rc) => ui.prefResult(rc)), "PRESETS").el),
      listbox("PRESETS", items, presetSel, { onSelect: (k) => { presetSel = k; draw(); }, onEnter: load }),
      el("div", { class: "acts" }, btn("symbol_folder_open", t("load"), () => load(presetSel), !presetSel || busy, true)));
    c.aside.textContent = String(rows.length);
    return c;
  }

  /* ---- LIBRARY: in this browser ---- */
  function library() {
    const v = lib.view(view), sel = lib.get(libSel);
    const all = [...new Set([...(dev ? dev.info.engines : lib.meta.engines || []), ...lib.patches.map((p) => p.engineName).filter(Boolean)])].filter((x) => x !== "-");
    const engs = engineOrder(all).map((i) => all[i]);
    const audition = (id) => {
      const p = lib.get(id);
      if (!p || !dev || busy) return;
      if (!dev.engineOk(p)) { ui.say(`${t("badEngine")} ${p.engineName || p.engine}`, "warn"); return; }
      run(() => dev.audition(p), (ok) => { if (ok) ui.say(`${t("audition")} ${p.name}`); });
    };
    const put = (id, slot) => {
      const p = lib.get(id);
      if (!p || !dev || !dev.bank || slot == null || busy) return;
      const s = dev.bank.slots[slot];
      if (!dev.engineOk(p)) { ui.say(`${t("badEngine")} ${p.engineName || p.engine}`, "warn"); return; }
      (async () => {
        if (s.used && !(await ui.confirm(`${t("overwrite")} ${slotName(slot)} ${s.name}?`))) return;
        run(() => dev.bankPut(slot, p), (ok) => { if (ok) ui.say(`${slotName(slot)} ${p.name}`); });
      })();
    };
    const del = async (id) => { const p = lib.get(id); if (p && (await ui.confirm(`${t("delete")} ${p.name}?`))) { await lib.remove(id); libSel = null; } };
    const rows = v.map((p) => ({
      key: p.id, name: p.name, drag: ["text/x-felucca-lib", p.id],
      cells: [el("span", { class: "tag", text: p.engineName || String(p.engine) }),
        el("span", { class: "nm" }, p.pattern || p.grid ? ic("symbol_grid_nine") : null, document.createTextNode(p.name)),
        el("span", { class: "tag", text: p.tags.join(" ") })],
    }));
    const list = listbox("LIBRARY", rows, libSel, {
      onSelect: (k) => { libSel = k; draw(); }, onEnter: audition,
      onKey: (e, k) => { if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); del(k); } },
    });
    const wrap = el("div", { class: "droplist" }, list);
    wrap.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/x-felucca-slot")) { e.preventDefault(); wrap.classList.add("over"); } });
    wrap.addEventListener("dragleave", () => wrap.classList.remove("over"));
    wrap.addEventListener("drop", (e) => {
      e.preventDefault(); wrap.classList.remove("over");
      const s = e.dataTransfer.getData("text/x-felucca-slot");
      if (s !== "" && dev) run(() => dev.bankGet(+s), async (pt) => { if (pt) { await lib.add([pt]); ui.say(`${t("kept")} ${pt.name}`); } });
    });
    const search = el("input", { class: "search", type: "search", value: view.q, "aria-label": t("search"), placeholder: t("search") });
    search.addEventListener("input", () => { view.q = search.value; const at = search.selectionStart; draw(); const n = $$("#s-library input.search")[0]; if (n) { n.focus(); n.setSelectionRange(at, at); } });
    const c = card("LIBRARY", "symbol_books",
      search,
      el("div", { class: "filters" },
        pickRow(t("engine"), view.engine, [["", "ALL"], ...engs.map((e) => [e, e])], (x) => { view.engine = x; draw(); }),
        pickRow("TAG", view.tag, [["", "ALL"], ...lib.tags().map((x) => [x, x])], (x) => { view.tag = x; draw(); }),
        pickRow(t("sort"), view.sort, SORTS.map((x) => [x, t("sort_" + x)]), (x) => { view.sort = x; draw(); })),
      wrap,
      el("div", { class: "acts wrap" },
        btn("control_play_f", t("audition"), () => audition(libSel), !sel || !dev || busy, true),
        btn("port_usb_c", bankSel == null ? t("toSlot") : `→ ${slotName(bankSel)}`, () => put(libSel, bankSel), !sel || !dev || !dev.bank || bankSel == null || busy),
        btn("symbol_pencil", t("rename"), async () => { const n = await ui.ask(t("rename"), sel.name); if (n && n.trim()) lib.update(sel, { name: n.trim().slice(0, 32) }); }, !sel),
        btn("symbol_tag", "TAGS", async () => { const n = await ui.ask("TAGS", sel.tags.join(", ")); if (n != null) lib.update(sel, { tags: [...new Set(n.split(",").map((x) => x.trim()).filter(Boolean))] }); }, !sel),
        btn("control_duplicate", t("duplicate"), () => lib.duplicate(sel), !sel),
        btn("symbol_trash", t("delete"), () => del(libSel), !sel),
        btn("symbol_download", t("export"), () => ui.download(`felucca-patch-${fileSlug(sel.name)}.json`, lib.file("patch", [sel], dev)), !sel)),
      el("div", { class: "acts wrap" },
        btn("symbol_download_as", t("keep"), async () => {
          if (!dev) return;
          const def = (dev.names[dev.dump.engine] || [])[dev.dump.preset] || dev.info.engines[dev.dump.engine];
          const name = await ui.ask(t("keep"), def);
          if (name == null) return;
          run(() => dev.capture(name.trim() || def), async (pt) => { if (pt) { await lib.add([pt]); ui.say(`${t("kept")} ${pt.name}`); } });
        }, !dev || busy),
        btn("symbol_upload", t("import"), () => fileInput.click()),
        btn("symbol_download", t("exportAll"), () => ui.download(`felucca-library-${today()}.json`, lib.file("library", lib.patches, dev)), !lib.patches.length)),
      fileInput);
    c.aside.textContent = `${v.length} / ${lib.patches.length}${lib.persistent ? "" : " · " + t("memoryOnly")}`;
    return c;
  }

  /* ---- USER BANK: the device's slots ---- */
  function userBank() {
    if (!dev || !dev.bank) return null;
    const b = dev.bank, s = bankSel == null ? null : b.slots[bankSel];
    const load = (slot) => { const x = b.slots[slot]; if (!x || !x.used || busy) return; run(() => dev.bankLoad(slot), (ok) => ui.say(ok ? `${t("loaded")} ${slotName(slot)} ${x.name}` : `${slotName(slot)} ${t("empty")}`)); };
    const rows = b.slots.map((x) => ({
      key: x.slot, name: x.used ? x.name : t("empty"), dim: !x.used,
      drag: x.used ? ["text/x-felucca-slot", String(x.slot)] : null,
      drop: ["text/x-felucca-lib", (id) => { bankSel = x.slot; const p = lib.get(id); if (p) libraryPut(id, x.slot); }],
      cells: [el("span", { class: "tag", text: slotName(x.slot) }),
        el("span", { class: "nm" }, x.used && ENGINE_IC[engineLabel(dev.info.engines, x.engine)] ? ic(ENGINE_IC[engineLabel(dev.info.engines, x.engine)]) : null, document.createTextNode(x.used ? x.name : "—")),
        el("span", { class: "tag", text: x.used ? engineLabel(dev.info.engines, x.engine) : "" })],
    }));
    const c = card("USER BANK", "port_usb_c",
      listbox("USER BANK", rows, bankSel, { onSelect: (k) => { bankSel = k; draw(); }, onEnter: load }),
      el("div", { class: "acts wrap" },
        btn("symbol_folder_open", t("load"), () => load(bankSel), !s || !s.used || busy, true),
        btn("symbol_download_as", t("store"), async () => {
          const name = await ui.ask(`${t("store")} ${slotName(bankSel)}`, s.used ? s.name : "");
          if (name == null) return;
          if (s.used && !(await ui.confirm(`${t("overwrite")} ${slotName(bankSel)} ${s.name}?`))) return;
          run(() => dev.bankStore(bankSel, name.trim()), (ok) => { if (ok) ui.say(`${slotName(bankSel)} ${dev.bank.slots[bankSel].name}`); });
        }, !s || busy),
        btn("symbol_books", t("toLibrary"), () => run(() => dev.bankGet(bankSel), async (pt) => { if (pt) { await lib.add([pt]); ui.say(`${t("kept")} ${pt.name}`); } }), !s || !s.used || busy),
        btn("symbol_trash", t("erase"), async () => { if (await ui.confirm(`${t("erase")} ${slotName(bankSel)} ${s.name}?`)) run(() => dev.bankErase(bankSel)); }, !s || !s.used || busy),
        btn("control_arrow_loop", "RELOAD", () => run(() => dev.bankRefresh()), busy),
        btn("symbol_download", t("export"), () => run(() => dev.bankAll(), (out) => { if (out) ui.download(`felucca-bank-${today()}.json`, lib.file("bank", out, dev)); }),
          !b.slots.some((x) => x.used) || busy)));
    c.aside.textContent = `${b.slots.filter((x) => x.used).length} / ${b.total}`;
    return c;
  }
  function libraryPut(id, slot) {
    const p = lib.get(id), s = dev.bank.slots[slot];
    if (!p || busy) return;
    if (!dev.engineOk(p)) { ui.say(`${t("badEngine")} ${p.engineName || p.engine}`, "warn"); return; }
    (async () => {
      if (s.used && !(await ui.confirm(`${t("overwrite")} ${slotName(slot)} ${s.name}?`))) return;
      run(() => dev.bankPut(slot, p), (ok) => { if (ok) ui.say(`${slotName(slot)} ${p.name}`); });
    })();
  }

  function draw() {
    const focus = document.activeElement && root.contains(document.activeElement) ? document.activeElement : null;
    const fkey = focus && focus.dataset ? focus.dataset.key : null, flist = focus && focus.closest("[role=listbox]") ? focus.closest("[role=listbox]").getAttribute("aria-label") : null;
    if (libSel && !lib.get(libSel)) libSel = null;
    const parts = [dev && dev.loaded ? presets() : null, library(), dev && dev.loaded ? userBank() : null].filter(Boolean);
    root.replaceChildren(el("div", { class: "grid" }, ...parts));
    if (fkey != null && flist) { const x = root.querySelector(`[role=listbox][aria-label="${flist}"] [data-key="${CSS.escape(fkey)}"]`); if (x) x.focus({ preventScroll: true }); }
  }
  lib.onChange(() => draw());
  return {
    show(device) { dev = device && device.loaded ? device : null; if (!dev) bankSel = null; draw(); },
    refresh() { draw(); },
  };
}
