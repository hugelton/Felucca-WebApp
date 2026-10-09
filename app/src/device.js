// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// One connected device: the read-everything sequence, live sync (WATCH pushes, PING keep-alive, re-WATCH after a
// gap) or DUMP polling on firmware without pushes, the busy count that keeps polling out of multi-request work,
// and the edits. No DOM: the page listens (on) and calls; the tests drive it against the mock device.
// The behaviour is editor.html's (connect, load, onPush, keepAlive, the 400 ms poll, selfLoad), moved here.

import { captureBackup, readBackup, restoreBackup } from "../../fm1backup.js";
import { CMD, F, FLASH_OPT, FM6, fm6Bank, midiLearn, Link, parseMotionAll, P_CHORD, SMP, auditionPatch, bank, capturePatch, fromDigital, mixer, parse, paramKeys, readDeviceMenu, readDevicePreferences, req, reservedFm4, startWatch, upName } from "./proto.js";

export const isFelucca = (p) => /felucca/i.test(p.name || "") && p.state !== "disconnected";
export const P = { LEVEL: 0, SLEN: 29 };
/* the layouts this editor knows (P_COUNT, P_E0 with G_COUNT 27; editor.html knownLayout) */
export const knownLayout = (info) => info.gcount === 27 &&
  [[111, 103], [104, 96], [99, 91], [91, 83], [89, 81], [69, 61], [57, 49]].some(([c, e]) => info.pcount === c && info.pe0 === e);
export const chordIds = P_CHORD;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Device {
  /* access: a MIDIAccess (or the mock's); opt.clock: () => ms (tests), opt.hidden: () => bool (the page hidden) */
  constructor(access, opt = {}) {
    this.access = access;
    this.now = opt.clock || (() => Date.now());
    this.hidden = opt.hidden || (() => false);
    this.handlers = new Map();
    this.info = null; this.pdesc = []; this.gdesc = []; this.names = []; this.titles = [];
    this.dump = null; this.steps = []; this.slotUsed = [null, null, null, null]; this.smp = null; this.keys = null;
    this.watch = false; this.v4 = false; this.bank = null; this.sel = 0; this.mix = null; this.song = null;
    this.motion = null; this.preferences = null; this.fm6 = null; this.menu = null;
    this.busy = 0; this.busyEpoch = 0; this.closed = false; this.loaded = false;
    this.needReload = false; this.lastDump = 0; this.rewatch = false; this.stepRR = 0;
    this.selfReload = { n: 0, until: 0 };
    this.touchedAt = new Map();                       /* "s:id" -> time of the user's last change */
    this.stepEdit = new Map();
    this.timers = [];
  }

  /* ---- events: progress, loaded, param, reload, step, track, mix, live, storage, menu, closed, error ---- */
  on(name, fn) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name).add(fn); return () => this.handlers.get(name).delete(fn); }
  emit(name, value) { for (const fn of this.handlers.get(name) || []) { try { fn(value); } catch (e) { console.error(e); } } }

  /* ---- the session ---- */
  /* finds the device's ports and reads everything; throws "nodevice", or the request's error */
  async open() {
    const input = [...this.access.inputs.values()].find(isFelucca);
    const output = [...this.access.outputs.values()].find(isFelucca);
    if (!input || !output) throw new Error("nodevice");
    this.input = input; this.output = output;
    this.link = new Link((d) => output.send(d), {
      timeout: 300,
      onUnknown: (f) => this.emit("unknown", f),      /* (Felucca-mirror: frames that are not replies come here) */
      onTimeout: () => this.emit("error", new Error("noreply")),
      onPush: (f) => this.onPush(f),
      onGap: () => { this.rewatch = true; },
    });
    input.onmidimessage = (e) => this.link.receive(e.data);
    if (input.open) await input.open().catch(() => {});
    await this.load();
    this.start();
  }

  close(reason = "disconnected") {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.link) this.link.close();
    if (this.input) this.input.onmidimessage = null;
    this.busyEpoch++; this.busy = 0;
    this.emit("closed", reason);
  }

  assert() { if (this.closed) throw new Error("closed"); }
  async rq(r, opt) { this.assert(); const reply = await this.link.request(r, opt); this.assert(); return reply; }
  beginBusy() {
    const epoch = this.busyEpoch;
    let released = false;
    this.busy++;
    return () => { if (!released && epoch === this.busyEpoch) this.busy--; released = true; };
  }
  /* one multi-request operation: polling waits for it; errors go to "error" */
  async op(fn) {
    if (this.closed) return undefined;
    const release = this.beginBusy();
    try { return await fn(); } catch (e) { if (e.message !== "closed") this.emit("error", e); return undefined; } finally { release(); }
  }
  async idle() { while (this.busy && !this.closed) await sleep(20); this.assert(); }

  async descOrNull(scope, i) {
    try { return parse[CMD.DESC](await this.rq(req.desc(scope, i))); } catch (e) { if (e.message === "closed") throw e; return null; }
  }
  async readDump() { const d = parse[CMD.DUMP](await this.rq(req.dump()), this.info); this.lastDump = this.now(); return d; }

  /* the whole connect sequence (editor.html load) */
  async load() {
    const release = this.beginBusy();
    try {
      /* the first frame after opening the port can be lost: a few tries */
      this.info = parse[CMD.INFO](await this.rq(req.info(), { timeout: 500, retries: 3 }));
      const i = this.info, total = i.pcount + i.gcount;
      this.emit("progress", { what: "info", info: i });
      for (let k = 0; k < i.pcount; k++) { this.emit("progress", { what: "desc", n: k + 1, total }); this.pdesc[k] = await this.descOrNull(0, k); }
      for (let k = 0; k < i.gcount; k++) { this.emit("progress", { what: "desc", n: i.pcount + k + 1, total }); this.gdesc[k] = await this.descOrNull(1, k); }
      for (let e = 0; e < i.nengines; e++) {
        const r = parse[CMD.NAMES](await this.rq(req.names(e)));
        this.names[e] = r.names; this.titles[e] = r.titles;
      }
      for (let k = 0; k < 4; k++) {                  /* PROJECT op 2: is the slot used */
        try { this.slotUsed[k] = parse[CMD.PROJECT](await this.rq(req.project(2, k))).used; } catch (e) { if (e.message === "closed") throw e; }
      }
      try { this.smp = parse[CMD.SMP_INFO](await this.rq(req.smpInfo())); } catch (e) { if (e.message === "closed") throw e; this.smp = null; }
      this.keys = paramKeys(this.pdesc, i.pe0, i.pcount);
      if (i.ntrk) this.sel = parse[CMD.TRACK](await this.rq(req.track())).sel;
      this.dump = await this.readDump();
      if (i.chainRows) this.song = parse[CMD.SONG](await this.rq(req.song(0, [], !!i.songLanes)));
      await this.loadSteps();
      if (i.ntrk) await this.readMixer();
      this.watch = await startWatch((r, o) => this.rq(r, o));
      this.v4 = this.watch === 3;
      if (this.watch) {
        try { this.bank = await bank.list((r, o) => this.rq(r, { ...o, quiet: true })); } catch (e) { if (e.message === "closed") throw e; this.bank = null; }
      }
      await this.syncPreferences();
      await this.readFm6List();
      if (this.info.fm6Bank) await this.readFm6Bank();
      if (this.info.menuCount) try { this.menu = await readDeviceMenu((r, o) => this.rq(r, o), this.info); } catch (e) { if (e.message === "closed") throw e; this.menu = null; }
      this.loaded = true;
      this.emit("loaded", this);
      this.emit("live", this.watch);
      this.emit("storage", this.storage());
    } finally { release(); }
  }

  async loadSteps() {
    const n = this.info.nstep;
    for (let k = 0; k < n; k++) { if (k % 8 === 0) this.emit("progress", { what: "steps", n: k, total: n }); this.steps[k] = parse[CMD.STEP_GET](await this.rq(req.stepGet(k))); }
    if (this.info.motionMax) await this.readMotion();
  }
  /* (1.1: the query with the kinds, op 7, so a lock stays one) */
  /* a track's records: 1.2 / 1.4 (INFO 41 01) all of them with op 8 (up to 128), with locks op 7 (their kinds), else
     the plain query */
  async motionAll(track = this.sel ?? 0) {
    if (this.info.motionCap) return parseMotionAll(await this.rq(req.motion(track, 8)));
    return parse[CMD.MOTION](await this.rq(req.motion(track, this.info.locks ? 7 : 0)));
  }
  async readMotion() {
    const m = await this.motionAll();
    if (m.rc || m.track !== (this.sel ?? 0)) throw new Error("motionState");
    this.motion = m;
  }
  /* the mixer: TRACK (sel, and per track engine, preset, level, mute, armed) + TRACK_DUMP for PAN and REV
     (the requests of proto.js mixer.read, with REV kept as well) */
  async readMixer() {
    if (!this.info.ntrk) return;
    const m = parse[CMD.TRACK](await this.rq(req.track()));
    for (let k = 0; k < m.ntrk; k++) {
      const d = parse[CMD.TRACK_DUMP](await this.rq(req.trackDump(k)), this.info);
      m.tracks[k].pan = d.p[this.panId()];
      m.tracks[k].rev = d.p[this.revId()];
    }
    if (this.mix) m.tracks.forEach((x, k) => {         /* what the user is moving stays */
      const o = this.mix.tracks[k];
      if (!o) return;
      if (this.touched("lv:" + k)) { x.level = o.level; x.mute = o.mute; }
      if (this.touched("pan:" + k)) x.pan = o.pan;
      if (this.touched("rev:" + k)) x.rev = o.rev;
    });
    this.mix = m;
    if (m.sel !== this.sel) { this.sel = m.sel; this.needReload = true; }   /* selected on the device, push missed */
    this.emit("mix", m);
  }
  async syncPreferences() {
    if (!this.info.uiCaps) return;
    this.preferences = await readDevicePreferences((r, o) => this.rq(r, o), this.info, this.names, this.preferences);
    if (this.preferences && this.preferences.slots) this.bank = this.preferences.slots;
    this.emit("preferences", this.preferences);
  }
  async readFm6List() {
    if (!this.info.fm6) return;
    try { this.fm6 = parse[CMD.FM6_LIST](await this.rq(req.fm6List())); } catch (e) { if (e.message === "closed") throw e; this.fm6 = null; }
  }

  /* ---- what the device holds (the header's FLASH): sample slots in KiB, the rest in slots ---- */
  storage() {
    const s = this.smp, used = (a) => a.filter(Boolean).length;
    return {
      slotKiB: s ? s.slotKiB : 0,
      samples: s ? s.slots.map((x, k) => ({ slot: k, name: x.zones ? x.name : "", kib: x.zones ? x.kib : 0 })) : [],
      presets: this.bank ? [used(this.bank.slots.map((x) => x.used)), this.bank.total] : null,
      projects: [used(this.slotUsed), this.slotUsed.length],
      fm6: this.fm6 && this.fm6.bank ? [used(this.fm6.slots.slice(this.fm6.factory).map((x) => x.used)), this.fm6.bank] : null,   /* (1.0.3: no bank) */
    };
  }

  /* ---- ids by DESC label (core.h; editor.html pById) ---- */
  pId(label, def) { const k = this.pdesc.findIndex((d, n) => d && n < this.info.pe0 && d.label === label); return k >= 0 ? k : def; }
  gId(label, def) { const k = this.gdesc.findIndex((d) => d && d.label === label); return k >= 0 ? k : def; }
  panId() { return this.pId("PAN", 39); }
  muteId() { return this.pId("MUTE", 40); }
  revId() { return this.pId("REV", 36); }
  pSlen() { const k = this.pdesc.findIndex((d) => d && d.fmt === F.STEPS); return k >= 0 ? k : P.SLEN; }
  engineName() { return this.info && this.dump ? this.info.engines[this.dump.engine] : ""; }

  touched(k) { return this.now() - (this.touchedAt.get(k) || 0) < 600 || (this.link && this.link.hasQueued(k)); }

  /* ---- edits ---- */
  /* a parameter of the selected track (scope 0) or a global (1): coalesced (the latest value wins), one in flight */
  async setParam(scope, id, value) {
    const k = scope + ":" + id;
    this.touchedAt.set(k, this.now());
    (scope ? this.dump.g : this.dump.p)[id] = value;
    try {
      const r = parse[CMD.SET](await this.rq(req.set(scope, id, value), { key: k }));
      this.touchedAt.set(k, this.now());
      (scope ? this.dump.g : this.dump.p)[id] = r.value;
      if (!scope) this.mixFromDump();
      return r.value;
    } catch (e) { if (e.message !== "closed") this.emit("error", e); return undefined; }
  }

  /* the editor's own sound loads: the RELOAD echo older firmware pushes is skipped (INFO 53 bit 1: none comes) */
  selfLoad(sound = false) {
    if (!this.watch || (sound && this.info.syncCaps & 2)) return;
    const t = this.now();
    this.selfReload.n = t < this.selfReload.until ? this.selfReload.n + 1 : 1;
    this.selfReload.until = t + 1500;
  }

  selectTrack(k) {
    if (!this.info.ntrk || k === this.sel) return Promise.resolve();
    return this.op(async () => {
      this.sel = parse[CMD.TRACK](await this.rq(req.track(k))).sel;
      await this.afterSoundChange();
    });
  }
  /* the selected track's sound changed (here or on the device): read it again */
  async afterSoundChange() {
    this.needReload = false;
    const engine = this.dump && this.dump.engine;
    this.dump = await this.readDump();
    if (this.dump.engine !== engine) await this.rereadEngineDesc();
    await this.loadSteps();
    await this.readMixer();
    this.emit("reload", this);
  }
  /* a factory preset (engine e, preset p) on the selected track */
  loadPreset(e, p) {
    return this.op(async () => {
      this.selfLoad(true);
      parse[CMD.PRESET](await this.rq(req.preset(e, p)));
      await this.afterSoundChange();
    });
  }
  /* the engine's plain sound (SET of G_ENGSEL to the engine it has) */
  initSound() {
    return this.op(async () => {
      this.selfLoad(true);
      await this.rq(req.set(1, this.gId("ENG", 20), this.dump.engine));
      await this.afterSoundChange();
    });
  }
  /* ---- the mixer ---- */
  /* the selected track's LEVEL / MUTE / PAN / REV are also SOUND parameters: the strip follows the dump */
  mixFromDump() {
    const x = this.mix && this.mix.tracks[this.sel];
    if (!x || !this.dump || this.panning) return;
    const k = this.sel, p = this.dump.p;
    const lv = p[P.LEVEL], mu = p[this.muteId()] ? 1 : 0, pan = p[this.panId()], rev = p[this.revId()];
    let changed = false;
    if (!this.touched("lv:" + k) && (x.level !== lv || x.mute !== mu)) { x.level = lv; x.mute = mu; changed = true; }
    if (!this.touched("pan:" + k) && x.pan !== pan) { x.pan = pan; changed = true; }
    if (!this.touched("rev:" + k) && x.rev !== rev) { x.rev = rev; changed = true; }
    if (changed) this.emit("track", k);
  }
  /* level and mute of track k: TRACK_MIX, one in flight and one queued with the latest values */
  async setMix(k, level, mute) {
    const x = this.mix.tracks[k];
    x.level = level; x.mute = mute ? 1 : 0;
    this.touchedAt.set("lv:" + k, this.now());
    if (k === this.sel) { this.dump.p[P.LEVEL] = x.level; this.dump.p[this.muteId()] = x.mute; this.emit("param", { scope: 0, id: P.LEVEL, value: x.level }); this.emit("param", { scope: 0, id: this.muteId(), value: x.mute }); }
    try {
      const r = await mixer.setMix((q, o) => this.rq(q, o), k, x.level, x.mute, { key: "lv:" + k });
      this.touchedAt.set("lv:" + k, this.now());
      if (this.link.hasQueued("lv:" + k)) return;
      x.level = r.level; x.mute = r.mute;           /* the device's values after clamping */
      if (k === this.sel) { this.dump.p[P.LEVEL] = r.level; this.dump.p[this.muteId()] = r.mute; }
      this.emit("track", k);
    } catch (e) { if (e.message !== "closed") this.emit("error", e); }
  }
  /* PAN or REV of track k (which: "pan" / "rev"): the selected track as any SOUND parameter; another with TRACK_PARAM
     (v4), or on firmware before it on release only, selecting that track for a moment (proto.js mixer.setPan's way) */
  async setTrackParam(k, which, v, final) {
    const x = this.mix.tracks[k], id = which === "pan" ? this.panId() : this.revId();
    x[which] = v;
    this.touchedAt.set(which + ":" + k, this.now());
    if (k === this.sel) { await this.setParam(0, id, v); this.emit("param", { scope: 0, id, value: this.dump.p[id] }); return; }
    if (this.v4) {
      try {
        const r = parse[CMD.TRACK_PARAM](await this.rq(req.trackParam(k, id, v), { key: which + ":" + k })).value;
        this.touchedAt.set(which + ":" + k, this.now());
        if (!this.link.hasQueued(which + ":" + k)) { x[which] = r; this.emit("track", k); }
      } catch (e) { if (e.message !== "closed") this.emit("error", e); }
      return;
    }
    if (!final) return;
    await this.idle();
    await this.op(async () => {
      const sel = this.sel;
      this.panning = true;
      try {
        await this.rq(req.track(k));
        try { x[which] = parse[CMD.SET](await this.rq(req.set(0, id, v))).value; }
        finally { await this.rq(req.track(sel)).catch(() => {}); }
      } finally { this.panning = false; }
      this.emit("track", k);
    });
  }

  /* ---- sounds: the user bank (UP_*), audition, capture, favourites (editor.html's library half) ---- */
  /* a sound the device can take: its engine is this device's (by number and name) */
  engineOk(p) { return p.engine < this.info.nengines && (!p.engineName || this.info.engines[p.engine] === p.engineName); }
  /* a full parameter set for UP_PUT: unknown values get the DESC default where it is known, else 0 */
  fullParams(p) {
    const out = [];
    for (let k = 0; k < this.info.pcount; k++) {
      let v = p.p[k];
      if (v == null) { const d = this.pdesc[k]; v = d && (k < this.info.pe0 || p.engine === this.dump.engine) ? d.def : 0; }
      out.push(v);
    }
    return out;
  }
  async refreshSlot(slot) {
    const r = parse[CMD.UP_LIST](await this.rq(req.upList(slot, 1)));
    if (this.bank && r.slots[0]) this.bank.slots[slot] = r.slots[0];
    this.emit("bank", this.bank);
  }
  flashRc(rc) { if (rc) { const e = new Error("flash " + rc); e.code = "flash"; e.rc = rc; throw e; } }
  bankRefresh() { return this.op(async () => { this.bank = await bank.list((r, o) => this.rq(r, o)); this.emit("bank", this.bank); this.emit("storage", this.storage()); }); }
  /* -> true when loaded (false: an empty slot) */
  bankLoad(slot) {
    return this.op(async () => {
      this.selfLoad();
      if (await bank.load((r, o) => this.rq(r, o), slot)) return false;
      await this.afterSoundChange();
      return true;
    });
  }
  /* the sound now playing into slot (name "": the device names it) */
  bankStore(slot, name) {
    return this.op(async () => { this.flashRc(await bank.store((r, o) => this.rq(r, o), slot, name)); await this.refreshSlot(slot); this.emit("storage", this.storage()); return true; });
  }
  bankErase(slot) {
    return this.op(async () => { this.flashRc(await bank.erase((r, o) => this.rq(r, o), slot)); await this.refreshSlot(slot); this.emit("storage", this.storage()); return true; });
  }
  /* slot -> a library patch (null: empty); a DIGITAL sound in a reserved slot comes as its FM6 conversion */
  async readSlot(slot) {
    const u = await bank.get((r, o) => this.rq(r, o), this.info, slot);
    if (!u.used) return null;
    const pt = { name: u.name, engine: u.engine, engineName: this.info.engines[u.engine], p: u.p, pattern: u.pattern, grid: u.grid, tags: ["device"],
      fm6: u.fm6, ...(u.category ? { category: u.category } : {}) };   /* (an FM6 sound's own patch, 1.0.3; the category, 1.4) */
    return reservedFm4(this.info.engines, u.engine) ? fromDigital(pt, this.info.engines, this.info.pe0) : pt;
  }
  bankGet(slot) { return this.op(() => this.readSlot(slot)); }
  /* every used slot, for a bank file (DIGITAL's own values for a reserved slot) */
  bankAll() {
    return this.op(async () => {
      const out = [];
      for (const x of this.bank.slots) {
        if (!x.used) continue;
        this.emit("progress", { what: "bank", n: x.slot + 1, total: this.bank.total });
        const u = await bank.get((r, o) => this.rq(r, o), this.info, x.slot);
        if (u.used) out.push({ name: u.name, engine: u.engine, p: u.p, pattern: u.pattern, grid: u.grid, slot: x.slot, fm6: u.fm6,
          ...(u.category ? { category: u.category } : {}),
          engineName: reservedFm4(this.info.engines, u.engine) ? "DIGITAL" : this.info.engines[u.engine] });
      }
      return out;
    });
  }
  /* a used slot's category (1.4): its sound read and written back with it */
  bankCategory(slot, cat) {
    return this.op(async () => {
      const u = await bank.get((r, o) => this.rq(r, o), this.info, slot);
      if (!u.used) return false;
      this.flashRc(await bank.put((r, o) => this.rq(r, o), slot, { ...u, category: cat }, this.info));
      await this.refreshSlot(slot);
      return true;
    });
  }
  /* a library patch into slot */
  bankPut(slot, p) {
    return this.op(async () => {
      if (!this.engineOk(p)) { const e = new Error("engine"); e.code = "engine"; throw e; }
      const keep4 = p.fm4 && this.info.engines[1] === "-" && p.fm4.length === this.info.pcount;   /* a converted DIGITAL sound:
                                                     its DIGITAL values as engine 1 (the device converts them on load) */
      this.flashRc(await bank.put((r, o) => this.rq(r, o), slot, keep4 ? { ...p, engine: 1, name: upName(p.name), p: this.fullParams({ ...p, p: p.fm4 }) }
        : { ...p, name: upName(p.name), p: this.fullParams(p) }, this.info));
      await this.refreshSlot(slot);
      this.emit("storage", this.storage());
      return true;
    });
  }
  /* a library patch on the selected track (the engine, then its values; its steps stay) */
  audition(p, onProgress) {
    return this.op(async () => {
      if (!this.engineOk(p)) { const e = new Error("engine"); e.code = "engine"; throw e; }
      this.selfLoad(true);
      await auditionPatch((r, o) => this.rq(r, o), this.info, p, { gEng: this.gId("ENG", 20), track: this.sel ?? 0, progress: onProgress });
      await this.afterSoundChange();
      return true;
    });
  }
  /* the sound now playing (with its first 16 steps as a pattern or grid) -> a library patch */
  capture(name) { return this.op(async () => (await capturePatch((r, o) => this.rq(r, o), this.info, name)).patch); }
  /* a factory preset -> a library patch (the sound only: the steps are the track's), the preset left loaded */
  captureFactory(e, k) {
    return this.op(async () => {
      this.selfLoad(true);
      await this.rq(req.preset(e, k));
      const { patch } = await capturePatch((r, o) => this.rq(r, o), this.info, (this.names[e] || [])[k] || "PRESET");
      await this.afterSoundChange();
      return { ...patch, pattern: null, grid: null, tags: ["factory"] };
    });
  }
  /* favourites (UI caps bit 3): a preset's star; -> rc */
  favorite(row, on) {
    return this.op(async () => {
      const r = parse[CMD.FAV_SET](await this.rq(req.favSet(row.engine, row.preset, on), FLASH_OPT));
      await this.syncPreferences();
      return r.rc;
    });
  }

  /* ---- projects, the song chain, the full backup ---- */
  /* PROJECT: op 0 load, 1 save (flash: a long timeout, no retry); -> {used} (a load of an empty slot: used 0) */
  project(op, slot) {
    return this.op(async () => {
      if (!op) this.selfLoad();
      const r = parse[CMD.PROJECT](await this.rq(req.project(op, slot), { timeout: 4000, retries: 0 }));
      this.slotUsed[slot] = r.used;
      if (!op && r.used) await this.afterSoundChange();
      if (this.info.chainRows) this.song = parse[CMD.SONG](await this.rq(req.song(0, [], !!this.info.songLanes)));
      this.emit("projects", this);
      this.emit("storage", this.storage());
      return r;
    });
  }
  /* SONG: action 1 set the rows ([{slot, repeat}], up to 16), 2 start, 3 stop; rc 2 busy, 3.. a slot that is empty */
  songOp(action, rows = []) {
    return this.op(async () => {
      /* (firmware with song sections, 57 01: ops 4..7 only; op 1 there would flatten the song) */
      const r = parse[CMD.SONG](await this.rq(req.song(action, rows, !!this.info.songLanes)));
      if (r.rc) { const e = new Error(r.rc >= 3 ? `slot ${r.rc - 2} empty` : r.rc === 2 ? "busy" : "invalid"); e.code = "song"; e.rc = r.rc; throw e; }
      this.song = r;
      this.emit("song", r);
      return r;
    });
  }
  /* the song is not pushed: the page polls it while PROJECT shows */
  async pollSong() {
    if (this.closed || this.busy || !this.info || !this.info.chainRows || this.hidden() || !this.link.idle) return;
    const release = this.beginBusy();
    try {
      const before = JSON.stringify(this.song);
      this.song = parse[CMD.SONG](await this.rq(req.song(0, [], !!this.info.songLanes)));
      if (JSON.stringify(this.song) !== before) this.emit("song", this.song);
    } catch (e) { if (e.message !== "closed") this.emit("error", e); } finally { release(); }
  }
  /* INFO 42: bit 0 read, bit 1 restore */
  backupCaps() { return this.info ? this.info.backupCaps | 0 : 0; }
  /* -> the backup file (felucca-backup v1: the music, settings, projects, user banks, the FM6 bank of 1.0..1.0.2 or (1.0.3)
     the user presets' FM6 patches, the sample slots) */
  backupSave(onProgress) {
    return this.op(() => captureBackup((r, o) => this.rq(r, o), this.info.version, onProgress));
  }
  /* a backup file (text) checked whole before the first write; then written, the music last, and everything read again */
  backupCheck(text) { return readBackup(text); }
  /* a backup this device cannot take back: a 1.4 project (3840 bytes, FUN10) on firmware before it (no INFO 41 01:
     it would answer rc 1 and keep nothing of that object) */
  /* (and a 1.5 project, FUN10 of 111 parameters, byte 66, on 1.2 .. 1.4: more parameters than this device has) */
  backupTooNew(archive) {
    const proj = (archive.objects || []).filter((o) => o.id <= 5 && o.id !== 1 && o.size === 3840);
    return (!this.info.motionCap && proj.length > 0) || proj.some((o) => o.bytes && String.fromCharCode(...o.bytes.slice(0, 4)) === "FUNA" && o.bytes[66] > this.info.pcount);
  }
  backupRestore(archive, onProgress) {
    if (this.backupTooNew(archive)) { this.emit("error", new Error("backupNewer")); return Promise.resolve(false); }
    return this.op(async () => {
      await restoreBackup((r, o) => this.rq(r, o), archive, onProgress);
      await this.load();
      this.emit("reload", this);
      return true;
    });
  }

  /* ---- FM6 patches (INFO 46): a track's own patch, the factory ones; 128-byte packed records ---- */
  fm6Ok() { return !!(this.info && this.info.fm6); }
  /* track k's patch -> packed (null: refused) */
  fm6Read(k) {
    return this.op(async () => {
      const r = parse[CMD.FM6_GET](await this.rq(req.fm6Get(FM6.TARGET.TRACK, k)));
      if (r.rc) { const e = new Error(`fm6 rc ${r.rc}`); e.code = "fm6"; e.rc = r.rc; throw e; }
      return r.packed;
    });
  }
  /* MIDI LEARN (1.5, INFO 43 01 16): the device's CC map, not pushed: read when settings show. -> this.learn
     {n, entries: [{used, cc, track, id}]} */
  async readLearn() {
    if (!this.info.midiLearn) { this.learn = null; return null; }
    try { this.learn = await midiLearn.list((r, o) => this.rq(r, o)); } catch (e) { if (e.message === "closed") throw e; this.learn = null; }
    this.emit("learn", this.learn);
    return this.learn;
  }
  /* cc to track's parameter id, or (id null) cc cleared, or (cc null) every CC cleared -> rc (0 saved; 1 refused,
     3 not saved, 4 saved at STOP, 5 sixteen learned already) */
  learnSet(cc, track, id) {
    return this.op(async () => {
      const rq = (r, o) => this.rq(r, o);
      const r = cc == null ? await midiLearn.clear(rq) : id == null ? await midiLearn.clear(rq, cc) : await midiLearn.set(rq, cc, track, id);
      this.learn = { n: r.n, entries: r.entries };
      this.emit("learn", this.learn);
      return r.rc;
    });
  }
  /* FM6's voice bank on the device (1.4.1, INFO 56 01 32): FM6B_LIST -> this.fm6bank {n, valid, name, voices} */
  async readFm6Bank() {
    if (!this.info.fm6Bank) { this.fm6bank = null; return null; }
    try { this.fm6bank = await fm6Bank.list((r, o) => this.rq(r, o)); } catch (e) { if (e.message === "closed") throw e; this.fm6bank = null; }
    return this.fm6bank;
  }
  /* packed: 32 records (null: none) -> rc (0: the device holds them now; else it keeps its previous bank) */
  fm6BankSend(packed, name, onProgress) {
    return this.op(async () => {
      const rc = await fm6Bank.send((r, o) => this.rq(r, o), packed, name, onProgress);
      await this.readFm6Bank();
      this.emit("fm6bank", this.fm6bank);
      return rc;
    });
  }
  /* factory patch i (F1..) -> packed */
  fm6Factory(i) {
    return this.op(async () => {
      const r = parse[CMD.FM6_GET](await this.rq(req.fm6Get(FM6.TARGET.FACTORY, i)));
      if (r.rc) { const e = new Error(`fm6 rc ${r.rc}`); e.code = "fm6"; e.rc = r.rc; throw e; }
      return r.packed;
    });
  }
  /* packed -> track k (the track keeps it: SLOT OWN). Coalesced: a live edit sends only the latest */
  async fm6Send(k, packed) {
    try {
      const r = parse[CMD.FM6_PUT](await this.rq(req.fm6Put(FM6.TARGET.TRACK, k, packed), { key: "fm6put:" + k }));
      if (r.rc) { const e = new Error(`fm6 rc ${r.rc}`); e.code = "fm6"; e.rc = r.rc; throw e; }
      return true;
    } catch (e) { if (e.message !== "closed") this.emit("error", e); return false; }
  }

  /* ---- user sample slots (SMP_*) ---- */
  async readSamples() { this.smp = parse[CMD.SMP_INFO](await this.rq(req.smpInfo())); this.emit("samples", this.smp); this.emit("storage", this.storage()); }
  /* slot k <- {hdr, data} (proto.js buildSlot): BEGIN, the data in 256-byte pieces, END (the header, its CRC);
     onProgress(bytes done, bytes). -> true; a refusal throws (code "smp", the step and its rc) */
  smpWrite(k, { hdr, data }, onProgress) {
    const fail = (what, rc) => { const e = new Error(`${what} rc ${rc}`); e.code = "smp"; e.rc = rc; e.what = what; throw e; };
    return this.op(async () => {
      try {
        let r = parse[CMD.SMP_BEGIN](await this.rq(req.smpBegin(k), { timeout: 1000, retries: 0 }));
        if (r.rc) fail("begin", r.rc);
        for (let off = 0; off < data.length; off += 256) {
          const w = parse[CMD.SMP_WRITE](await this.rq(req.smpWrite(k, SMP.DATA_OFF + off, data.subarray(off, off + 256)), { timeout: 1000, retries: 1 }));
          if (w.rc) fail("write", w.rc);
          if (onProgress) onProgress(Math.min(data.length, off + 256), data.length);
        }
        r = parse[CMD.SMP_END](await this.rq(req.smpEnd(k, hdr), { timeout: 2000, retries: 0 }));
        if (r.rc) fail("end", r.rc);
        return true;
      } finally { try { await this.readSamples(); } catch { /* shown by the next action */ } }
    });
  }
  smpErase(k) {
    return this.op(async () => {
      try {
        const r = parse[CMD.SMP_ERASE](await this.rq(req.smpErase(k), { timeout: 2500, retries: 0 }));
        if (r.rc) { const e = new Error(`erase rc ${r.rc}`); e.code = "smp"; e.rc = r.rc; throw e; }
        return true;
      } finally { try { await this.readSamples(); } catch { /* ignore */ } }
    });
  }

  /* ---- steps (STEP_SET) and MOTION ---- */
  stepLen() { return Math.max(1, Math.min(this.info.nstep, this.dump.p[this.pSlen()] || 16)); }
  /* step i becomes s ({n, notes[4], time, flags, vel, hit, acc, chance, ratchet, nudge}); -> the step as the device has
     it (the ratchet goes only with the chance before it: 1.0.5; the nudge only with the ratchet: 1.2 / 1.4) */
  async writeStep(k, s) {
    this.stepEdit.set(k, this.now());
    const st = { ...s };
    if (!this.info.chance) delete st.chance;
    /* (a nudge needs the ratchet before it, the ratchet the chance: the step's own when not given) */
    if (this.info.nudge && st.nudge != null && st.ratchet == null) st.ratchet = (this.steps[k] && this.steps[k].ratchet) || 1;
    if (st.ratchet != null && st.chance == null && this.info.chance) st.chance = (this.steps[k] && this.steps[k].chance) ?? 100;
    if (!this.info.ratchet || !this.info.chance) delete st.ratchet;
    else if (st.ratchet != null && st.chance == null) st.chance = 100;
    if (!this.info.nudge || st.ratchet == null) delete st.nudge;
    try {
      this.steps[k] = parse[CMD.STEP_SET](await this.rq(req.stepSet(k, st), { key: "stepset:" + k }));
      this.stepEdit.set(k, this.now());
      this.emit("step", k);
      return this.steps[k];
    } catch (e) { if (e.message !== "closed") this.emit("error", e); return undefined; }
  }
  /* every step empty (and the track's motion cleared) */
  clearSequence() {
    return this.op(async () => {
      for (let k = 0; k < this.info.nstep; k++) {
        if (k % 8 === 0) this.emit("progress", { what: "steps", n: k, total: this.info.nstep });
        this.steps[k] = parse[CMD.STEP_SET](await this.rq(req.stepSet(k, { n: 0, notes: [0, 0, 0, 0], time: 2, flags: 0, vel: 0, hit: 0, acc: 0,
          ...(this.info.chance ? { chance: 100 } : {}), ...(this.info.chance && this.info.ratchet ? { ratchet: 1 } : {}),
          ...(this.info.chance && this.info.ratchet && this.info.nudge ? { nudge: 0 } : {}) })));
      }
      if (this.info.motionMax) { await this.rq(req.motion(this.sel ?? 0, 2)); this.motion = await this.motionAll(); }
      this.emit("steps", this);
    });
  }
  reloadSteps() { return this.op(async () => { await this.loadSteps(); this.emit("steps", this); }); }
  /* MOTION: op 1 on / off, 2 clear, 3 set an event ({step, param, value}), 4 delete one; 1.1: 5 set a lock, 6 clear a
     step's locks; -> rc (0 ok). With locks the reply is read again with the kinds (ops 1..4 reply without) */
  motionOp(op, arg) {
    return this.op(async () => {
      let r = parse[CMD.MOTION](await this.rq(req.motion(this.sel ?? 0, op, arg)));
      /* (the reply of ops 1..7 lists at most 64, and ops 1..4 no kinds: read again, op 8 or 7) */
      if (!r.rc && (this.info.motionCap || (this.info.locks && op < 5))) r = await this.motionAll();
      if (!r.rc && r.track === (this.sel ?? 0)) { this.motion = r; this.emit("motion", r); }
      return r.rc;
    });
  }
  /* the device pushes nothing about motion: the page polls it while the sequence shows */
  async pollMotion() {
    if (this.closed || this.busy || !this.info || !this.info.motionMax || this.hidden() || !this.link.idle) return;
    const release = this.beginBusy();
    try {
      const before = JSON.stringify(this.motion);
      await this.readMotion();
      if (JSON.stringify(this.motion) !== before) this.emit("motion", this.motion);
    } catch (e) { if (e.message !== "closed") this.emit("error", e); } finally { release(); }
  }
  async rereadEngineDesc() {
    const pe0 = this.info.pe0;
    for (let k = 0; k < 8 && pe0 + k < this.info.pcount; k++) this.pdesc[pe0 + k] = await this.descOrNull(0, pe0 + k);
  }
  /* ---- MENU settings (1.0.4: INFO menuCount; MENU_DESC 72, MENU_SET 73): not pushed, read when settings show ---- */
  async readMenu() {
    if (!this.info || !this.info.menuCount) return null;
    await this.idle();
    const items = await this.op(async () => { const x = await readDeviceMenu((r, o) => this.rq(r, o), this.info); if (this.info.midiLearn) await this.readLearn(); return x; });
    if (items) { this.menu = items; this.emit("menu", items); }
    return this.menu;
  }
  /* -> rc (as UI_SET: 0 saved, 3 not saved, 4 after STOP, 1 refused); USB SERIAL changed: the device leaves the bus
     and comes back (every USB port), so this connection ends ("usb") and the page connects again */
  async menuSet(id, value) {
    await this.idle();
    const m = (this.menu || []).find((x) => x.id === id);
    const before = m ? m.value : null;
    const rc = await this.op(async () => {
      const r = parse[CMD.MENU_SET](await this.rq(req.menuSet(id, value), FLASH_OPT));
      if (m && !r.rc) m.value = r.value;
      if (id === 0 && !r.rc) await this.syncPreferences();   /* (COLOR is the display preference 0) */
      return r.rc;
    });
    if (m && m.name === "USB SERIAL" && rc === 0 && m.value !== before) this.close("usb");
    else this.emit("menu", this.menu);
    return rc;
  }

  async changePreference(id, value) {
    await this.idle();
    return this.op(async () => {
      const r = parse[CMD.UI_SET](await this.rq(req.uiSet(id, value), FLASH_OPT));
      await this.syncPreferences();
      return r.rc;
    });
  }

  /* ---- pushes (editor.html onPush) ---- */
  onPush(f) {
    if (!this.dump || !this.info) return;
    try {
      if (f.cmd === CMD.CHANGED) {
        const c = parse[CMD.CHANGED](f.a);
        const arr = c.scope ? this.dump.g : this.dump.p;
        if (this.panning && !c.scope) return;          /* about the track selected for a moment, not ours */
        if (c.id >= arr.length || this.touched(c.scope + ":" + c.id)) return;   /* the user's value wins */
        arr[c.id] = c.value;
        this.emit("param", { scope: c.scope, id: c.id, value: c.value, remote: true });
        if (!c.scope) this.mixFromDump();
      } else if (f.cmd === CMD.RELOAD) {
        this.sel = parse[CMD.RELOAD](f.a).track;
        if (this.selfReload.n > 0 && this.now() < this.selfReload.until) { this.selfReload.n--; return; }
        this.needReload = true;
        this.maybeReload();
      } else if (f.cmd === CMD.STEP_CHANGED) {
        const { index } = parse[CMD.STEP_CHANGED](f.a);
        if (index < this.info.nstep) this.refreshStep(index);
      } else if (f.cmd === CMD.TRACK_CHANGED) {
        const c = parse[CMD.TRACK_CHANGED](f.a), x = this.mix && this.mix.tracks[c.track];
        if (!x || c.track === this.sel) return;
        if (c.id === this.panId()) { if (!this.touched("pan:" + c.track)) x.pan = c.value; }
        else if (c.id === this.revId()) { if (!this.touched("rev:" + c.track)) x.rev = c.value; }
        else if (c.id === this.muteId()) { if (!this.touched("lv:" + c.track)) x.mute = c.value ? 1 : 0; }
        else if (c.id === P.LEVEL) { if (!this.touched("lv:" + c.track)) x.level = c.value; }
        else return;
        this.emit("track", c.track);
      }
    } catch (e) { console.warn("bad push", f, e); }
  }
  async refreshStep(k) {
    try {
      const s = parse[CMD.STEP_GET](await this.rq(req.stepGet(k), { key: "step:" + k }));
      if (s.index !== k) return;
      this.steps[k] = s;
      this.emit("step", k);
    } catch (e) { if (e.message !== "closed") this.emit("error", e); }
  }
  maybeReload() {
    if (this.closed || this.busy || !this.needReload || !this.dump) return;
    this.op(() => this.afterSoundChange());
  }

  /* ---- timers: keep-alive (1 s) and the poll (400 ms) ---- */
  start() {
    this.timers.push(setInterval(() => this.keepAlive(), 1000), setInterval(() => this.poll(), 400));
  }
  /* PING when nothing else went out for ~1 s; after a longer gap the watch may have ended: WATCH again and re-read */
  async keepAlive() {
    if (this.closed || !this.watch || !this.dump || this.hidden()) return;
    const gap = this.now() - this.link.lastSent;
    if (this.rewatch || gap > 2500) {
      if (this.watching) return;
      this.watching = true;
      try {
        const on = await startWatch((r, o) => this.rq(r, o));
        this.rewatch = false;
        if (on) { this.v4 = on === 3; this.needReload = true; this.maybeReload(); }
        else { this.watch = false; this.emit("live", false); }
      } catch (e) { /* closed */ } finally { this.watching = false; }
    } else if (gap > 850 && this.link.idle) {
      this.link.request(req.ping(), { key: "ping", quiet: true, retries: 0 }).catch(() => {});
    }
  }
  /* the page came back: the watch may have ended */
  visible() { if (this.watch && !this.closed) { this.rewatch = true; this.keepAlive(); } }
  /* DUMP every 5 s with WATCH (a safety net), every 400 ms without; steps two at a time without WATCH */
  async poll() {
    if (this.closed || this.busy || this.hidden() || !this.dump || !this.link.idle) return;
    if (this.needReload) { this.maybeReload(); return; }
    if (this.watch && this.now() - this.lastDump < 5000) return;
    const release = this.beginBusy();
    try {
      const dump = await this.readDump();
      const soundChanged = dump.engine !== this.dump.engine || dump.preset !== this.dump.preset;
      const engineChanged = dump.engine !== this.dump.engine;
      for (const [arr, old, s] of [[dump.p, this.dump.p, 0], [dump.g, this.dump.g, 1]])
        arr.forEach((v, k) => {
          if (this.touched(s + ":" + k)) { arr[k] = old[k]; return; }
          if (v !== old[k]) this.emit("param", { scope: s, id: k, value: v, remote: true });
        });
      this.dump = dump;
      if (engineChanged) await this.rereadEngineDesc();
      if (this.info.ntrk) await this.readMixer();
      if (soundChanged) { await this.loadSteps(); this.emit("reload", this); return; }
      if (this.watch) return;                       /* steps come as STEP_CHANGED */
      const len = Math.max(1, Math.min(this.info.nstep, dump.p[this.pSlen()] || 16));
      for (let n = 0; n < 2; n++) {
        this.stepRR = (this.stepRR + 1) % len;
        if (this.now() - (this.stepEdit.get(this.stepRR) || 0) < 1500) continue;
        const s = parse[CMD.STEP_GET](await this.rq(req.stepGet(this.stepRR)));
        const o = this.steps[this.stepRR];
        this.steps[this.stepRR] = s;
        if (JSON.stringify(o) !== JSON.stringify(s)) this.emit("step", this.stepRR);
      }
    } catch (e) { if (e.message !== "closed") this.emit("error", e); } finally { release(); }
  }
}
