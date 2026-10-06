// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// The library: sounds kept in this browser (IndexedDB "felucca-editor": store "patches" by id, store "meta" key
// "layout" = the parameter keys and engine names the values are in). The same database the earlier editor used,
// so a library carries over. No DOM: the page renders it; the tests give it a store in memory.
// Without IndexedDB (some private windows) the library lives in memory only.

import { ENGINE_ORDER, cleanPatch, fromDigital, fromPerc, libraryFile, readLibraryFile, remapParams, sameKeys } from "./proto.js";

/* IndexedDB as {ok, all, putMany, del, getMeta, setMeta} (editor.html store) */
export function indexedStore(name = "felucca-editor") {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res) => {
    try {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("patches", { keyPath: "id" }); r.result.createObjectStore("meta"); };
      r.onsuccess = () => res(r.result);
      r.onerror = r.onblocked = () => res(null);
    } catch { res(null); }
  }));
  const tx = async (os, mode, fn) => {
    const db = await open();
    if (!db) return undefined;
    return new Promise((res, rej) => {
      const x = db.transaction(os, mode);
      let out;
      const r = fn(x.objectStore(os));
      if (r) r.onsuccess = () => { out = r.result; };
      x.oncomplete = () => res(out);
      x.onerror = x.onabort = () => rej(x.error || new Error("IndexedDB"));
    });
  };
  return {
    ok: async () => !!(await open()),
    all: () => tx("patches", "readonly", (os) => os.getAll()),
    putMany: (ps) => tx("patches", "readwrite", (os) => { ps.forEach((p) => os.put(p)); }),
    del: (id) => tx("patches", "readwrite", (os) => os.delete(id)),
    getMeta: (k) => tx("meta", "readonly", (os) => os.get(k)),
    setMeta: (k, v) => tx("meta", "readwrite", (os) => os.put(v, k)),
  };
}
/* the same in memory (no IndexedDB; the tests) */
export function memoryStore() {
  const ps = new Map(), meta = new Map();
  return {
    ok: async () => true, all: async () => [...ps.values()].map((p) => structuredClone(p)),
    putMany: async (list) => { list.forEach((p) => ps.set(p.id, structuredClone(p))); },
    del: async (id) => { ps.delete(id); },
    getMeta: async (k) => structuredClone(meta.get(k)), setMeta: async (k, v) => { meta.set(k, structuredClone(v)); },
  };
}

const newId = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const nowIso = () => new Date().toISOString();
const engRank = (n) => { const k = ENGINE_ORDER.indexOf(n); return k < 0 ? ENGINE_ORDER.length : k; };
export const SORTS = ["modified", "created", "name", "engine"];

export class Library {
  constructor(store) {
    this.store = store;
    this.patches = [];
    this.meta = { keys: null, engines: null, pe0: null };
    this.persistent = false;
    this.handlers = new Set();
  }
  onChange(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  changed() { for (const fn of this.handlers) { try { fn(this); } catch (e) { console.error(e); } } }
  async init() {
    try {
      this.persistent = await this.store.ok();
      if (this.persistent) {
        this.patches = ((await this.store.all()) || []).filter((p) => p && p.id);
        this.meta = (await this.store.getMeta("layout")) || this.meta;
      }
    } catch (e) { console.warn(e); this.persistent = false; }
    this.changed();
  }
  async write(ps) { if (this.persistent) await this.store.putMany(ps); }
  /* the layout of the device (or the library's own) the values are read in */
  ctx(dev) {
    return dev && dev.keys ? { keys: dev.keys, engines: dev.info.engines, firmware: dev.info.version, pe0: dev.info.pe0 }
      : { keys: this.meta.keys, engines: this.meta.engines, firmware: "", pe0: this.meta.pe0 };
  }
  get(id) { return this.patches.find((p) => p.id === id) || null; }
  async add(list) {
    const add = list.map((p) => ({ ...cleanPatch(p), id: newId() }));
    this.patches.push(...add);
    await this.write(add);
    this.changed();
    return add;
  }
  async update(p, patch = {}) {
    Object.assign(p, patch, { modified: nowIso() });
    await this.write([p]);
    this.changed();
    return p;
  }
  async remove(id) {
    this.patches = this.patches.filter((p) => p.id !== id);
    if (this.persistent) await this.store.del(id);
    this.changed();
  }
  duplicate(p) { return this.add([{ ...p, name: (p.name + " 2").slice(0, 32), created: nowIso(), modified: nowIso() }]); }
  /* the device's parameter layout becomes the library's; sounds stored in another are mapped by key. A device without
     DIGITAL (engine 1 "-"): DIGITAL sounds become FM6 (fromDigital); SAMPLE PERC sounds DRUM's kit (fromPerc)
     (editor.html libAdopt) */
  async adopt(dev) {
    const keys = dev.keys, engines = dev.info.engines, changed = [];
    const relayout = (this.meta.keys && !sameKeys(this.meta.keys, keys)) || (this.meta.engines && !sameKeys(this.meta.engines, engines));
    const noFm4 = (engines || [])[1] === "-";
    for (const p of this.patches) {
      const name = p.engineName || (this.meta.engines || [])[p.engine];
      const digital = noFm4 && !p.fm6 && (name === "DIGITAL" || ((!name || name === "-") && p.engine === 1));
      const pe0 = () => (keys && p.p.length === keys.length ? dev.info.pe0 : p.p.length - 8);   /* (E1..E8: the last 8) */
      const perc = !digital && !!fromPerc({ ...p, engineName: name }, engines, p.p.length - 8);
      if (!relayout && !digital && !perc) continue;
      if (relayout) p.p = remapParams(p.p, this.meta.keys, keys);
      const pt = digital ? fromDigital(p, engines, pe0()) : perc ? fromPerc({ ...p, engineName: name }, engines, pe0()) : null;
      if (pt) Object.assign(p, cleanPatch(pt));
      else {
        const e = name ? engines.indexOf(name) : p.engine;
        if (e >= 0) { p.engine = e; p.engineName = engines[e]; }
      }
      changed.push(p);
    }
    this.meta = { keys, engines, pe0: dev.info.pe0 };
    if (changed.length) await this.write(changed);
    try { if (this.persistent) await this.store.setMeta("layout", this.meta); } catch (e) { console.warn(e); }
    this.changed();
    return changed.length;
  }
  /* what the list shows: q (name or tag), an engine, a tag, a sort */
  view({ q = "", engine = "", tag = "", sort = "modified" } = {}) {
    const s = q.trim().toLowerCase();
    const by = {
      name: (a, b) => a.name.localeCompare(b.name),
      engine: (a, b) => engRank(a.engineName) - engRank(b.engineName) || (a.engineName || "").localeCompare(b.engineName || "") || a.name.localeCompare(b.name),
      created: (a, b) => b.created.localeCompare(a.created),
      modified: (a, b) => b.modified.localeCompare(a.modified),
    }[sort] || ((a, b) => b.modified.localeCompare(a.modified));
    return this.patches.filter((p) => (!s || p.name.toLowerCase().includes(s) || p.tags.some((x) => x.toLowerCase().includes(s)))
      && (!engine || p.engineName === engine) && (!tag || p.tags.includes(tag))).sort(by);
  }
  tags() { return [...new Set(this.patches.flatMap((p) => p.tags))].sort(); }
  /* files: library / bank / patch JSON (and the earlier felucca-patch); -> {added, skipped, errors: [[name, message]]}.
     A bad file is reported and the rest still read */
  async importFiles(files, dev) {
    let added = 0, skipped = 0;
    const errors = [];
    for (const { name, text } of files) {
      try {
        const obj = JSON.parse(text);
        const ctx = this.ctx(dev);
        const r = readLibraryFile(obj, ctx);
        if (!ctx.keys && r.keys) {                   /* no layout yet: the file's becomes the library's */
          this.meta = { keys: r.keys, engines: Array.isArray(obj.engines) ? obj.engines : null, pe0: obj.pE0 ?? null };
          try { if (this.persistent) await this.store.setMeta("layout", this.meta); } catch (e) { console.warn(e); }
        }
        if (obj.kind === "bank") r.patches.forEach((p) => { if (!p.tags.includes("bank")) p.tags.push("bank"); });
        added += (await this.add(r.patches)).length;
        skipped += r.skipped;
      } catch (e) { errors.push([name, e.message]); }
    }
    return { added, skipped, errors };
  }
  file(kind, patches, dev) { return libraryFile(kind, patches, this.ctx(dev)); }
}

export const slotName = (i) => "U" + String(i + 1).padStart(2, "0");
export const fileSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "patch";
export const today = () => new Date().toISOString().slice(0, 10);
