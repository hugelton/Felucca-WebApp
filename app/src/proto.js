// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// The editor's protocol layer: framing, the request builders and reply parsers, the one-frame Link, value
// formatting, the user-sample codec, the library formats, the FM6 / FM4 patch tools and the mock device.
// No DOM. Moved from editor.html (its PROTO-BEGIN .. PROTO-END section); test_web.mjs runs its protocol
// checks against both (FELUCCA_PROTO=app: this file). Since the move, only the mock has changed, towards the firmware:
// - MOTION set / delete refuse (rc 1) a step >= 64, a parameter that cannot be recorded and a value out of range
// - INFO advertises the full backup (42 01 03) and BACKUP_LIST / GET / PUT answer as the firmware's (opt.noBackup: not)
// - 1.0.4: the MENU settings (INFO 4E 01 count, MENU_DESC 72, MENU_SET 73; opt.noMenu: not), the firmware's items (MENU)
/*PROTO-BEGIN*/
/* ---------------------------------------------------------------- protocol --- */
const HDR = [0x7D, 0x46, 0x4C];
const CMD = { INFO: 1, GET: 2, SET: 3, DUMP: 4, DESC: 5, STEP_GET: 6, STEP_SET: 7, PRESET: 8, PROJECT: 9, NAMES: 10,
  SMP_BEGIN: 11, SMP_WRITE: 12, SMP_END: 13, SMP_ERASE: 14, SMP_INFO: 15,
  UP_LIST: 16, UP_GET: 17, UP_PUT: 18, UP_STORE: 19, UP_LOAD: 20, UP_ERASE: 21,
  WATCH: 22, CHANGED: 23, RELOAD: 24, PING: 25, STEP_CHANGED: 26,
  TRACK: 27, TRACK_MIX: 28, TRACK_DUMP: 29, TRACK_STEP: 30,
  TRACK_PARAM: 31, TRACK_CHANGED: 32, SONG: 33,
  UI_STATE: 34, UI_SET: 35, UI_PALETTES: 36, FAV_GET: 37, FAV_SET: 38,
  MOTION: 64, BACKUP_LIST: 65, BACKUP_GET: 66, BACKUP_PUT: 67,
  FM6_GET: 68, FM6_PUT: 69, FM6_LIST: 70, FM6_ERASE: 71, MENU_DESC: 72, MENU_SET: 73 };
/* frames the device sends on its own (while WATCH is on); never replies */
const PUSH = new Set([CMD.CHANGED, CMD.RELOAD, CMD.STEP_CHANGED, CMD.TRACK_CHANGED]);
/* user preset bank: name 1..12 printable ASCII, a 16-step pattern of (note, flags 1 acc 2 slide 4 tie) */
const UP = { NAME_MAX: 12, PAT: 16, LIST_MAX: 16 };
const F = { INT: 0, PCT: 1, BIPCT: 2, TIME: 3, LFOHZ: 4, CUTOFF: 5, DB: 6, SEMI: 7, ENUM: 8, BPM: 9, NOTE: 10, ONOFF: 11, OCT: 12, STEPS: 13 };

const v14enc = (v) => { const u = Math.max(-8192, Math.min(8191, Math.round(v))) + 8192; return [u & 0x7F, (u >> 7) & 0x7F]; };
const v14dec = (lo, hi) => (lo | (hi << 7)) - 8192;
function strEnc(s) { const a = []; for (const c of String(s)) a.push(c.charCodeAt(0) & 0x7F); a.push(0); return a; }

/* only ever builds F0 7D 46 4C ... F7 */
function frame(cmd, args = []) {
  for (const b of args) if (!(Number.isInteger(b) && b >= 0 && b <= 0x7F)) throw new Error("bad data byte " + b);
  return [0xF0, ...HDR, cmd & 0x7F, ...args, 0xF7];
}
/* -> {cmd, a} or null when it is not an editor frame */
function unframe(d) {
  if (!d || d.length < 6 || d[0] !== 0xF0 || d[d.length - 1] !== 0xF7) return null;
  if (d[1] !== HDR[0] || d[2] !== HDR[1] || d[3] !== HDR[2]) return null;
  return { cmd: d[4], a: Array.from(d.slice(5, d.length - 1)) };
}

/* the DRUM grid (firmware v5): a step's lane hits and their accents, bit l = lane l. Each lane plays its GM note
   (eng_drum.c DRUM_LANE_NOTE) on any engine; LANE_OF: the lane a GM note 35..81 strikes (drum_lane; others fold
   to their octave of 36..47) */
const LANES = ["KICK", "SNARE", "CLAP", "HATCL", "HATOP", "TOM", "RIM", "BELL"];
const LANE_NOTE = [36, 38, 39, 42, 46, 45, 37, 56];
const LANE_OF = "00612153535455757773777675555555773366336665577";
const LANE_ALIAS = { CONGA: 5, CLAVE: 6, CYM: 7, BD: 0, SD: 1, CP: 2, CH: 3, OH: 4 };
const drumLane = (n) => +LANE_OF[(n >= 35 && n <= 81 ? n : 36 + ((n + 120 - 36) % 12)) - 35];
/* the lanes a step strikes (its hits, its notes on their lanes) and which are accented (step_lanes / step_accents) */
const stepLanes = (s) => (s.time !== 0 ? 0 : s.notes.slice(0, s.n).reduce((m, n) => m | (1 << drumLane(n)), s.hit | 0));
const stepAccents = (s) => (s.flags & 1 ? stepLanes(s) : (s.acc | 0) & stepLanes(s));
/* hits as text, an accent marked ">" ("KICK >SNARE HATCL"), and back: null when a word is not a lane */
const hitsText = (hit, acc) => LANES.map((nm, l) => (hit >> l & 1 ? (acc >> l & 1 ? ">" : "") + nm : "")).filter(Boolean).join(" ");
function parseHits(text) {
  let hit = 0, acc = 0;
  for (const w of String(text).toUpperCase().split(/[\s,]+/).filter(Boolean)) {
    const a = w.startsWith(">"), nm = a ? w.slice(1) : w, l = LANES.includes(nm) ? LANES.indexOf(nm) : LANE_ALIAS[nm];
    if (l == null) return null;
    hit |= 1 << l;
    if (a) acc |= 1 << l;
  }
  return { hit, acc };
}
/* the 3 bytes after a step (v5): hit & 127, acc & 127, bit 7 of each; an older firmware's step has none (0) */
const hitsEnc = (hit, acc) => [hit & 0x7F, acc & 0x7F, (hit >> 7 & 1) | (acc >> 7 & 1) << 1];
function readHits(r, o) {
  o.hit = 0; o.acc = 0;
  if (r.i + 3 <= r.a.length) { const h = r.b(), c = r.b(), x = r.b(); o.hit = h | (x & 1) << 7; o.acc = (c | (x & 2) << 6) & o.hit; }
  o.chance = r.i < r.a.length ? r.b() : 100;
  if (o.chance > 100) throw new Error("Invalid step chance");
  return o;
}

class Reader {
  constructor(a) { this.a = a; this.i = 0; }
  b() { if (this.i >= this.a.length) throw new Error("short reply"); return this.a[this.i++]; }
  v() { const lo = this.b(); return v14dec(lo, this.b()); }
  s() { let s = ""; for (;;) { const c = this.b(); if (!c) return s; s += String.fromCharCode(c); } }
}

const parse = {
  [CMD.INFO](a) {
    const r = new Reader(a);
    const o = { version: r.s(), nengines: r.b(), pcount: r.b(), gcount: r.b(), nstep: r.b(), pe0: r.b(), engines: [] };
    for (let i = 0; i < o.nengines; i++) o.engines.push(r.s());
    o.chainRows = 0;
    o.ntrk = r.i < a.length ? r.b() : 0;             /* v3: tracks (0 = older firmware, one instrument) */
    o.uiCaps = 0;
    const trailer = a.slice(r.i);
    if (trailer[0] === 16) o.chainRows = 16;       /* existing v6 SONG capability */
    if (trailer.length >= 4 && trailer[0] === 16 && trailer[1] === 0x55 && trailer[2] === 1)
      o.uiCaps = trailer[3] & 15;                 /* tagged preferences; never interpret old PR bytes as SONG */
    o.motionMax = 0; o.chance = false; o.backupCaps = 0;
    if (o.uiCaps && trailer[4] === 0x4d && trailer[5] === 1 && trailer[6] === 64) {
      o.motionMax = 64; o.chance = trailer[7] === 1;
      if (trailer[8] === 0x42 && trailer[9] === 1) o.backupCaps = trailer[10] & 3;
    }
    o.fm6 = null;                                 /* FM6 patches (cmds 68..71): the factory and bank slot counts */
    o.syncCaps = 0;                               /* live sync: bit 0 WATCH while on keeps pending pushes, bit 1 no RELOAD */
    for (const p of [8, 11]) if (o.motionMax && trailer[p] === 0x46 && trailer[p + 1] === 1) {   /* for the editor's */
      o.fm6 = { factory: trailer[p + 2], bank: trailer[p + 3], caps: 0 };                         /* PRESET / G_ENGSEL */
      if (trailer[p + 4] === 0x53 && trailer[p + 5] === 1) o.syncCaps = trailer[p + 6] & 3;
      /* FM6 v2 (1.0.3): bit 0 no bank (SLOT F1..F8, 8 = OWN), bit 1 the user presets carry their patch (target 3) */
      if (trailer[p + 7] === 0x50 && trailer[p + 8] === 1) o.fm6.caps = trailer[p + 9] & 3;
      /* MENU settings (1.0.4): the items MENU_DESC offers (index 0..menuCount-1) */
      if (trailer[p + 7] === 0x50 && trailer[p + 10] === 0x4E && trailer[p + 11] === 1) o.menuCount = trailer[p + 12];
    }
    o.menuCount = o.menuCount || 0;
    return o;
  },
  [CMD.UI_STATE](a) {
    const r = new Reader(a), o = { caps: r.b(), palette: r.b(), font: r.b(), monitor: r.b(), filter: r.b() };
    const u28 = () => r.b() | r.b() << 7 | r.b() << 14 | r.b() << 21;
    o.favoriteSig = u28(); o.bankSig = u28(); return o;
  },
  [CMD.UI_SET](a) { const r = new Reader(a); return { rc: r.b(), id: r.b(), value: r.b(), ...parse[CMD.UI_STATE](a.slice(3)) }; },
  [CMD.UI_PALETTES](a) { const r = new Reader(a), n = r.b(); return Array.from({ length: n }, () => r.s()); },
  [CMD.FAV_GET](a) {
    const r = new Reader(a), rc = r.b(); if (rc) return { rc };
    const o = { rc, engine: r.b(), start: r.v(), count: r.b() };
    o.values = Array.from({ length: o.count }, () => !!r.b()); return o;
  },
  [CMD.FAV_SET](a) {
    const r = new Reader(a), rc = r.b();
    return rc === 0 || rc === 3 || rc === 4 ? { rc, engine: r.b(), preset: r.v(), on: !!r.b() } : { rc };
  },
  [CMD.GET](a) { const r = new Reader(a); return { scope: r.b(), id: r.b(), value: r.v() }; },
  [CMD.SET](a) { return parse[CMD.GET](a); },
  /* needs the counts from INFO */
  [CMD.DUMP](a, info) {
    const r = new Reader(a);
    const o = { engine: r.b(), preset: r.b(), p: [], g: [] };
    for (let i = 0; i < info.pcount; i++) o.p.push(r.v());
    for (let i = 0; i < info.gcount; i++) o.g.push(r.v());
    return o;
  },
  [CMD.DESC](a) {
    const r = new Reader(a);
    const o = { scope: r.b(), id: r.b(), fmt: r.b(), min: r.v(), max: r.v(), def: r.v(), label: r.s(), unit: r.s(), names: [] };
    if (o.fmt === F.ENUM) for (let i = 0; i <= o.max - o.min && i < 24; i++) o.names.push(r.s());
    return o;
  },
  [CMD.STEP_GET](a) {
    const r = new Reader(a);
    const o = { index: r.b(), n: r.b(), notes: [r.b(), r.b(), r.b(), r.b()], time: r.b(), flags: r.b(), vel: r.b() };
    return readHits(r, o);
  },
  [CMD.STEP_SET](a) { return parse[CMD.STEP_GET](a); },
  [CMD.PRESET](a) { const r = new Reader(a); return { engine: r.b(), preset: r.b() }; },
  [CMD.PROJECT](a) { const r = new Reader(a); return { op: r.b(), slot: r.b(), used: r.b() }; },
  [CMD.SONG](a) {
    const r = new Reader(a);
    const o = { op: r.b(), rc: r.b(), count: r.b(), playing: r.b(), row: r.b(), remaining: r.b(), rows: [] };
    for (let i = 0; i < o.count; i++) o.rows.push({ slot: r.b(), repeat: r.b() });
    return o;
  },
  [CMD.MOTION](a) {
    const r = new Reader(a), o = { track: r.b(), rc: r.b(), on: !!r.b(), count: r.b(), max: r.b(), events: [] };
    if (o.count > o.max || o.max !== 64 || a.length !== 5 + o.count * 4) throw new Error("Invalid motion reply");
    for (let i = 0; i < o.count; i++) o.events.push({ step: r.b(), param: r.b(), value: r.v() });
    return o;
  },
  [CMD.NAMES](a) {
    const r = new Reader(a);
    const o = { engine: r.b(), names: [] };
    const n = r.b();
    for (let i = 0; i < n; i++) o.names.push(r.s());
    o.titles = [];
    try { o.titles.push(r.s(), r.s()); } catch (e) { o.titles = []; }   /* older firmware: no page titles */
    return o;
  },
  [CMD.SMP_BEGIN](a) { const r = new Reader(a); return { slot: r.b(), rc: r.b() }; },
  [CMD.SMP_WRITE](a) { const r = new Reader(a); return { slot: r.b(), offset: r.b() | (r.b() << 7) | (r.b() << 14), rc: r.b() }; },
  [CMD.SMP_END](a) { return parse[CMD.SMP_BEGIN](a); },
  [CMD.SMP_ERASE](a) { return parse[CMD.SMP_BEGIN](a); },
  [CMD.SMP_INFO](a) {
    const r = new Reader(a);
    const o = { nslots: r.b(), slotKiB: r.b(), slots: [] };
    for (let i = 0; i < o.nslots; i++) o.slots.push({ zones: r.b(), name: r.s(), kib: r.b() });
    return o;
  },
  [CMD.UP_LIST](a) {
    const r = new Reader(a);
    const o = { start: r.b(), count: r.b(), total: r.b(), slots: [] };
    for (let i = 0; i < o.count; i++) o.slots.push({ slot: o.start + i, used: r.b(), engine: r.b(), name: r.s() });
    return o;
  },
  /* needs P_COUNT from INFO */
  [CMD.UP_GET](a, info) {
    const r = new Reader(a);
    const o = { slot: r.b(), used: r.b(), engine: r.b(), name: r.s(), p: [], pattern: [] };
    for (let i = 0; i < info.pcount; i++) o.p.push(r.v());
    for (let i = 0; i < UP.PAT; i++) o.pattern.push([r.b(), r.b()]);
    o.grid = null;                                   /* v5: kind 1 = a drum grid (the pairs its low 7 bits), 16 x hi */
    if (r.i < a.length && r.b() === 1 && r.i + UP.PAT <= a.length) {
      o.grid = o.pattern.map(([h, c]) => { const x = r.b(), hit = h | (x & 1) << 7; return [hit, (c | (x & 2) << 6) & hit]; });
      o.pattern = null;
    }
    return o;
  },
  [CMD.UP_PUT](a) { return parse[CMD.SMP_BEGIN](a); },
  [CMD.UP_STORE](a) { return parse[CMD.SMP_BEGIN](a); },
  [CMD.UP_LOAD](a) { return parse[CMD.SMP_BEGIN](a); },
  [CMD.UP_ERASE](a) { return parse[CMD.SMP_BEGIN](a); },
  [CMD.WATCH](a) { return { on: new Reader(a).b() }; },
  [CMD.CHANGED](a) { return parse[CMD.GET](a); },
  [CMD.RELOAD](a) { const r = new Reader(a); return { engine: r.b(), preset: r.b(), track: r.i < a.length ? r.b() : 0 }; },
  [CMD.PING](a) { return {}; },
  [CMD.STEP_CHANGED](a) { const r = new Reader(a); return { index: r.b(), track: r.i < a.length ? r.b() : 0 }; },
  /* v3: tracks (1.0: four synth parts; earlier firmware: track 4 the drum part, engine byte NENGINES) */
  [CMD.TRACK](a) {
    const r = new Reader(a);
    const o = { sel: r.b(), ntrk: r.b(), tracks: [] };
    for (let i = 0; i < o.ntrk; i++) o.tracks.push({ engine: r.b(), preset: r.b(), level: r.v(), mute: r.b(), armed: r.b() });
    return o;
  },
  [CMD.TRACK_MIX](a) { const r = new Reader(a); return { track: r.b(), level: r.v(), mute: r.b() }; },
  [CMD.TRACK_DUMP](a, info) {
    const r = new Reader(a);
    const o = { track: r.b(), engine: r.b(), preset: r.b(), p: [] };
    for (let i = 0; i < info.pcount; i++) o.p.push(r.v());
    return o;
  },
  [CMD.TRACK_STEP](a) {
    const r = new Reader(a);
    return readHits(r, { track: r.b(), index: r.b(), n: r.b(), notes: [r.b(), r.b(), r.b(), r.b()], time: r.b(), flags: r.b(), vel: r.b() });
  },
  /* v4: a parameter of any track (the selection stays), and its push for a track that is not selected */
  [CMD.TRACK_PARAM](a) { const r = new Reader(a); return { track: r.b(), id: r.b(), value: r.v() }; },
  [CMD.TRACK_CHANGED](a) { return parse[CMD.TRACK_PARAM](a); },
  /* FM6 patches: target 0 a track, 1 the bank (retired in 1.0.3: rc 3), 2 a factory patch, 3 a user preset's patch
     (INFO fm6.caps bit 1); packed: the 128-byte record */
  [CMD.FM6_GET](a) { return { target: a[0], index: a[1], rc: a[2], packed: a[2] ? null : a.slice(3, 3 + 128) }; },
  [CMD.FM6_PUT](a) { return { target: a[0], index: a[1], rc: a[2] }; },
  [CMD.FM6_LIST](a) {
    const r = new Reader(a), o = { factory: r.b(), bank: r.b(), slots: [] };
    for (let i = 0; i < o.factory + o.bank; i++) { const used = r.b(); o.slots.push({ used: !!used, name: r.s() }); }
    return o;
  },
  [CMD.FM6_ERASE](a) { return { index: a[0], rc: a[1] }; },
  /* MENU settings: kind 0 an enum (one name per value min..max), 1 a number with a unit; id 127: no item at index */
  [CMD.MENU_DESC](a) {
    const r = new Reader(a), o = { index: r.b(), id: r.b() };
    if (o.id === 127) return o;
    Object.assign(o, { kind: r.b(), value: r.v(), min: r.v(), max: r.v(), name: r.s(), unit: "", names: null });
    if (o.kind === 1) o.unit = r.s();
    else if (o.kind === 0) o.names = Array.from({ length: o.max - o.min + 1 }, () => r.s());
    return o;
  },
  [CMD.MENU_SET](a) { const r = new Reader(a); return { rc: r.b(), id: r.b(), value: r.v() }; },
};

/* a name the device accepts: printable ASCII, 1..12 characters */
function upName(s) { return String(s ?? "").replace(/[^\x20-\x7E]/g, "").trim().slice(0, UP.NAME_MAX) || "PATCH"; }

const req = {
  uiState: () => [CMD.UI_STATE, []],
  uiSet: (id, value) => [CMD.UI_SET, [id, value]],
  uiPalettes: () => [CMD.UI_PALETTES, []],
  favGet: (engine, start, count) => [CMD.FAV_GET, [engine, ...v14enc(start), count]],
  favSet: (engine, preset, on) => [CMD.FAV_SET, [engine, ...v14enc(preset), on ? 1 : 0]],
  info: () => [CMD.INFO, []],
  get: (scope, id) => [CMD.GET, [scope, id]],
  set: (scope, id, v) => [CMD.SET, [scope, id, ...v14enc(v)]],
  dump: () => [CMD.DUMP, []],
  desc: (scope, id) => [CMD.DESC, [scope, id]],
  stepGet: (i) => [CMD.STEP_GET, [i]],
  stepSet: (i, st) => {
    const n = Math.max(0, Math.min(4, st.n | 0));
    const notes = [0, 1, 2, 3].map((k) => (st.notes[k] | 0) & 0x7F);
    return [CMD.STEP_SET, [i, n, ...notes, Math.max(0, Math.min(2, st.time | 0)), st.flags & 3, (st.vel | 0) & 0x7F,
      ...(st.hit == null && st.chance == null ? [] : hitsEnc(st.hit | 0, st.acc | 0)),
      ...(st.chance == null ? [] : [Math.max(0, Math.min(100, st.chance | 0))])]];
  },
  preset: (e, p) => [CMD.PRESET, [e & 0x7F, p & 0x7F]],
  project: (op, slot) => { if (![0, 1, 2].includes(op)) throw new Error("bad PROJECT op"); return [CMD.PROJECT, [op, slot & 3]]; },   /* 0 load, 1 save, 2 query */
  song: (op = 0, rows = []) => {
    if (![0, 1, 2, 3].includes(op) || rows.length > 16 || rows.some((r) => !Number.isInteger(r.slot) || r.slot < 0 || r.slot > 3 || !Number.isInteger(r.repeat) || r.repeat < 1 || r.repeat > 16)) throw new Error("bad SONG rows");
    return [CMD.SONG, op === 1 ? [op, rows.length, ...rows.flatMap((r) => [r.slot, r.repeat])] : [op]];
  },
  motion: (track, op = 0, arg = {}) => {
    if (!Number.isInteger(track) || track < 0 || track > 3 || ![0, 1, 2, 3, 4].includes(op)) throw new Error("Invalid motion request");
    return [CMD.MOTION, [track, ...(op === 0 ? [] : op === 1 ? [op, arg.on ? 1 : 0] : op === 2 ? [op] :
      [op, arg.step & 63, arg.param & 127, ...(op === 3 ? v14enc(arg.value) : [])])]];
  },
  names: (e) => [CMD.NAMES, [e & 0x7F]],
  smpBegin: (s) => [CMD.SMP_BEGIN, [s & 0x7F]],
  smpWrite: (s, off, bytes) => [CMD.SMP_WRITE, [s & 0x7F, off & 0x7F, (off >> 7) & 0x7F, (off >> 14) & 0x7F, ...pack7(bytes)]],
  smpEnd: (s, hdr) => [CMD.SMP_END, [s & 0x7F, ...pack7(hdr)]],
  smpErase: (s) => [CMD.SMP_ERASE, [s & 0x7F]],
  smpInfo: () => [CMD.SMP_INFO, []],
  upList: (start, count) => [CMD.UP_LIST, [start & 0x7F, Math.max(1, Math.min(UP.LIST_MAX, count | 0))]],
  upGet: (s) => [CMD.UP_GET, [s & 0x7F]],
  /* patch: {engine, name, p: P_COUNT values, pattern: 16 x [note, flags] or grid: 16 x [hit, acc] (v5: kind 1)} */
  upPut: (s, pt) => [CMD.UP_PUT, [s & 0x7F, pt.engine & 0x7F, ...strEnc(upName(pt.name)), ...pt.p.flatMap((v) => v14enc(v ?? 0)),
    ...(pt.grid
      ? [...Array.from({ length: UP.PAT }, (_, i) => hitsEnc(...(pt.grid[i] || [0, 0])).slice(0, 2)).flat(), 1,
         ...Array.from({ length: UP.PAT }, (_, i) => hitsEnc(...(pt.grid[i] || [0, 0]))[2])]
      : Array.from({ length: UP.PAT }, (_, i) => { const x = (pt.pattern || [])[i] || [0, 0]; return [x[0] & 0x7F, x[1] & 7]; }).flat())]],
  upStore: (s, name) => [CMD.UP_STORE, [s & 0x7F, ...strEnc(name ? upName(name) : "")]],   /* "": the device names it ("ANALOG 07") */
  upLoad: (s) => [CMD.UP_LOAD, [s & 0x7F]],
  upErase: (s) => [CMD.UP_ERASE, [s & 0x7F]],
  /* on: 1 = pushes; 3 = also TRACK_CHANGED (v4 firmware answers 3, older firmware 1) */
  watch: (on) => [CMD.WATCH, [on === 3 ? 3 : on ? 1 : 0]],
  ping: () => [CMD.PING, []],
  /* v3: tracks 0..3 */
  track: (sel) => [CMD.TRACK, sel == null ? [] : [sel & 0x7F]],
  trackMix: (tr, level, mute) => [CMD.TRACK_MIX, level == null ? [tr & 0x7F] : [tr & 0x7F, ...v14enc(level), mute ? 1 : 0]],
  trackDump: (tr) => [CMD.TRACK_DUMP, [tr & 0x7F]],
  trackStep: (tr, i, st) => [CMD.TRACK_STEP, st ? [tr & 0x7F, ...req.stepSet(i, st)[1]] : [tr & 0x7F, i & 0x7F]],
  /* v4: get (v == null) or set parameter id (P_*) of track tr, clamped as SET */
  trackParam: (tr, id, v) => [CMD.TRACK_PARAM, v == null ? [tr & 0x7F, id & 0x7F] : [tr & 0x7F, id & 0x7F, ...v14enc(v)]],
  /* FM6 patches (firmware with info.fm6) */
  fm6Get: (target, i) => [CMD.FM6_GET, [target & 0x7F, i & 0x7F]],
  fm6Put: (target, i, packed) => [CMD.FM6_PUT, [target & 0x7F, i & 0x7F, ...packed.map((x) => x & 0x7F)]],
  fm6List: () => [CMD.FM6_LIST, []],
  fm6Erase: (i) => [CMD.FM6_ERASE, [i & 0x7F]],
  /* MENU settings (firmware with info.menuCount) */
  menuDesc: (i) => [CMD.MENU_DESC, [i & 0x7F]],
  menuSet: (id, v) => [CMD.MENU_SET, [id & 0x7F, ...v14enc(v)]],
};

/* which reply belongs to which request (the device echoes these) */
function replyMatches(cmd, args, a) {
  switch (cmd) {
    case CMD.MOTION: return a[0] === args[0];
    case CMD.BACKUP_GET: return a[0] === args[0] && a.slice(2, 7).every((v, i) => v === args[i + 1]);
    case CMD.BACKUP_PUT: return a[0] === args[0] && a[1] === args[1];
    case CMD.UI_SET: return a[1] === args[0] && a[2] === args[1];
    case CMD.FAV_GET: case CMD.FAV_SET:
      return ![0, 3, 4].includes(a[0]) || (a[1] === args[0] && a[2] === args[1] && a[3] === args[2] && a[4] === args[3]);
    case CMD.GET: case CMD.SET: case CMD.DESC: return a[0] === args[0] && a[1] === args[1];
    case CMD.STEP_GET: case CMD.STEP_SET: case CMD.NAMES:
    case CMD.SMP_BEGIN: case CMD.SMP_END: case CMD.SMP_ERASE: return a[0] === args[0];
    case CMD.SMP_WRITE: return a[0] === args[0] && a[1] === args[1] && a[2] === args[2] && a[3] === args[3];
    case CMD.SONG: return a[0] === args[0];
    case CMD.FM6_GET: case CMD.FM6_PUT: return a[0] === args[0] && a[1] === args[1];
    case CMD.FM6_ERASE: return a[0] === args[0];
    case CMD.MENU_DESC: return a[0] === args[0];
    case CMD.MENU_SET: return a[1] === args[0];
    case CMD.PROJECT: return a[0] === args[0] && a[1] === args[1];
    case CMD.UP_LIST: case CMD.UP_GET: case CMD.UP_PUT: case CMD.UP_STORE: case CMD.UP_LOAD: case CMD.UP_ERASE:
    case CMD.TRACK_MIX: case CMD.TRACK_DUMP: return a[0] === args[0];
    case CMD.WATCH: return (a[0] & 1) === (args[0] & 1);   /* bit 1: v4 firmware only */
    case CMD.TRACK_STEP: case CMD.TRACK_PARAM: return a[0] === args[0] && a[1] === args[1];
    default: return true;
  }
}

/* strict request/response: one frame in flight, the rest queued. Push frames (CHANGED, RELOAD,
   STEP_CHANGED) can come at any time, also between a request and its reply: they go to onPush. */
class Link {
  constructor(send, opts = {}) {
    this.sendRaw = send;
    this.q = [];
    this.cur = null;
    this.closed = false;
    this.lastSent = 0;                              /* Date.now() of the last frame sent (WATCH keep-alive) */
    this.timeout = opts.timeout || 300;
    this.onUnknown = opts.onUnknown || (() => {});
    this.onTimeout = opts.onTimeout || (() => {});
    this.onPush = opts.onPush || (() => {});
    this.onGap = opts.onGap || (() => {});         /* (ms) nothing was sent for that long (WATCH may have ended) */
  }
  get idle() { return !this.cur && !this.q.length; }
  hasQueued(key) { return this.q.some((r) => r.key === key); }
  /* r = [cmd, args]; opt: {timeout, retries, key (coalesce queued requests: the latest args win), front,
     quiet (a timeout is expected: no onTimeout)} */
  request(r, opt = {}) {
    if (this.closed) return Promise.reject(new Error("closed"));
    const [cmd, args] = r;
    if (opt.key) {
      const old = this.q.find((x) => x.key === opt.key);
      if (old) { old.cmd = cmd; old.args = args; return old.promise; }
    }
    let res, rej;
    const promise = new Promise((a, b) => { res = a; rej = b; });
    const item = { cmd, args, key: opt.key, res, rej, promise, quiet: !!opt.quiet,
      timeout: opt.timeout || this.timeout, retries: opt.retries ?? 1 };
    if (opt.front) this.q.unshift(item); else this.q.push(item);
    this.pump();
    return promise;
  }
  pump() {
    if (this.cur || this.closed || !this.q.length) return;
    this.cur = this.q.shift();
    this.fire();
  }
  fire() {
    const c = this.cur;
    const now = Date.now();
    if (this.lastSent && now - this.lastSent > 2500) this.onGap(now - this.lastSent);
    this.lastSent = now;
    try { this.sendRaw(frame(c.cmd, c.args)); } catch (e) { this.finish(null, e); return; }
    c.timer = setTimeout(() => {
      if (this.cur !== c) return;
      if (c.retries-- > 0) { this.fire(); return; }
      if (!c.quiet) this.onTimeout(c.cmd);
      this.finish(null, new Error("timeout (cmd " + c.cmd + ")"));
    }, c.timeout);
  }
  finish(val, err) {
    const c = this.cur;
    if (!c) return;
    clearTimeout(c.timer);
    this.cur = null;
    if (err) c.rej(err); else c.res(val);
    this.pump();
  }
  /* raw incoming MIDI bytes */
  receive(data) {
    const f = unframe(data);
    if (!f) return;                                  /* not ours (notes, clock, other SysEx) */
    if (PUSH.has(f.cmd)) { this.onPush(f); return; }
    const c = this.cur;
    if (!c || f.cmd !== c.cmd || !replyMatches(c.cmd, c.args, f.a)) { this.onUnknown(f); return; }
    this.finish(f.a);
  }
  close() {
    this.closed = true;
    const all = (this.cur ? [this.cur] : []).concat(this.q);
    if (this.cur) clearTimeout(this.cur.timer);
    this.cur = null;
    this.q = [];
    for (const r of all) r.rej(new Error("closed"));
  }
}

/* ------------------------------------------------------------- formatting --- */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (n) => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);   /* 60 = C4 */
/* a note token: a number or a note name (C4, F#3, Bb2) */
function parseNote(tok) {
  if (/^\d+$/.test(tok)) { const n = +tok; return n <= 127 ? n : null; }
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(tok);
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
  const n = base + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (parseInt(m[3], 10) + 1) * 12;
  return n >= 0 && n <= 127 ? n : null;
}
/* "C4 E4 G4" -> [60, 64, 67]; null on a bad token or more than 4 notes */
function parseNotes(s) {
  const t = s.trim().split(/[\s,]+/).filter(Boolean);
  if (t.length > 4) return null;
  const out = t.map(parseNote);
  return out.includes(null) ? null : out;
}

/* close to the device's param_format (params.c), tables from tools/gen_tables.py */
function fmtValue(d, v) {
  const sign = (x) => (x > 0 ? "+" + x : String(x));
  switch (d.fmt) {
    case F.PCT: return [String(d.max === 100 ? v : Math.trunc((v * 100 + 63) / 127)), "%"];   /* 0..100 (SWG): the value */
    case F.BIPCT: return [sign(Math.trunc(v * 100 / 64)), "%"];
    case F.TIME: {
      const ms10 = Math.round(10 * Math.pow(10000, (v & 127) / 127));
      if (ms10 < 100) return [(ms10 / 10).toFixed(1), "ms"];
      if (ms10 < 10000) return [String(Math.round(ms10 / 10)), "ms"];
      return [(ms10 / 10000).toFixed(2), "s"];
    }
    case F.LFOHZ: { const h = 0.05 * Math.pow(800, (v & 127) / 127); return [h < 10 ? h.toFixed(2) : h.toFixed(1), "Hz"]; }
    case F.CUTOFF: { const h = 30 * Math.pow(16000 / 30, (v & 127) / 127); return h < 1000 ? [String(Math.round(h)), "Hz"] : [(h / 1000).toFixed(1), "kHz"]; }
    case F.DB: return v <= 0 ? ["OFF", ""] : [((v - 112) / 2).toFixed(1), "dB"];
    case F.SEMI: return [sign(v), "st"];
    case F.ENUM: return [d.names[v - d.min] ?? String(v), d.unit || ""];
    case F.BPM: return [String(v), "BPM"];
    case F.NOTE: return [NOTE_NAMES[((v % 12) + 12) % 12], ""];
    case F.ONOFF: return [v ? "ON" : "OFF", ""];
    case F.STEPS: return [String(v), "STEP"];
    default: return [String(v), d.unit || ""];
  }
}

/* ---------------------------------------------------------- user samples --- */
/* A port of felucca/tools/sampleio.py (read_any_wav, resample, to_int16, ima_encode, user_slot),
   byte for byte: felucca/web/test_web.mjs compares them. */
const SMP = { SLOT_SIZE: 0x14000, DATA_OFF: 512, RATE: 22050, HDR_LEN: 32 + 16 * 28, MAX_ZONES: 16 };
SMP.MAX_DATA = SMP.SLOT_SIZE - SMP.DATA_OFF;

/* groups of up to 7 bytes, each preceded by their top bits */
function pack7(b) {
  const out = [];
  for (let i = 0; i < b.length; i += 7) {
    const g = Array.from(b.slice(i, i + 7));
    out.push(g.reduce((m, x, j) => m | (((x >> 7) & 1) << j), 0));
    for (const x of g) out.push(x & 0x7F);
  }
  return out;
}
function unpack7(a) {
  const out = [];
  for (let i = 0; i < a.length; i += 8) {
    const top = a[i];
    for (let j = 0; j < 7 && i + 1 + j < a.length; j++) out.push(a[i + 1 + j] | (((top >> j) & 1) << 7));
  }
  return Uint8Array.from(out);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

const IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88,
  97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658,
  724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660,
  4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818,
  18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IMA_IDX = [-1, -1, -1, -1, 2, 4, 6, 8];
/* IMA ADPCM, 4 bit, low nibble first, from predictor 0 / index 0 -> {data, pred, idx} (state at loopStart) */
function imaEncode(s, loopStart = 0) {
  let pred = 0, idx = 0, atLoop = [0, 0];
  const nib = new Uint8Array(s.length + (s.length & 1));
  for (let n = 0; n < s.length; n++) {
    if (n === loopStart) atLoop = [pred, idx];
    const step = IMA_STEP[idx];
    let diff = s[n] - pred, code = 0;
    if (diff < 0) { code = 8; diff = -diff; }
    let vd = step >> 3;
    if (diff >= step) { code |= 4; diff -= step; vd += step; }
    if (diff >= step >> 1) { code |= 2; diff -= step >> 1; vd += step >> 1; }
    if (diff >= step >> 2) { code |= 1; vd += step >> 2; }
    pred = Math.max(-32768, Math.min(32767, code & 8 ? pred - vd : pred + vd));
    idx = Math.max(0, Math.min(88, idx + IMA_IDX[code & 7]));
    nib[n] = code;
  }
  const out = new Uint8Array(nib.length >> 1);
  for (let k = 0; k < nib.length; k += 2) out[k >> 1] = nib[k] | (nib[k + 1] << 4);
  return { data: out, pred: atLoop[0], idx: atLoop[1] };
}

/* WAV: PCM 8/16/24/32 or float, any channel count, mixed to mono -> {sr, x} (gen_samples.read_any_wav) */
function parseWav(buf) {
  const d = new Uint8Array(buf), v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const id = (i) => String.fromCharCode(d[i], d[i + 1], d[i + 2], d[i + 3]);
  if (d.length < 12 || id(0) !== "RIFF" || id(8) !== "WAVE") throw new Error("not a WAV file");
  let i = 12, fmt = null, data = null;
  while (i + 8 <= d.length) {
    const cid = id(i), n = v.getUint32(i + 4, true);
    if (cid === "fmt ") {
      let tag = v.getUint16(i + 8, true);
      const ch = v.getUint16(i + 10, true), sr = v.getUint32(i + 12, true), bits = v.getUint16(i + 22, true);
      if (tag === 0xFFFE) tag = v.getUint16(i + 32, true);
      fmt = { tag, ch, sr, bits };
    } else if (cid === "data") {
      data = [i + 8, Math.min(d.length, i + 8 + n)];
      break;
    }
    i += 8 + n + (n & 1);
  }
  if (!fmt || !data) throw new Error("WAV without fmt/data");
  const { tag, ch, sr, bits } = fmt, bps = bits >> 3, frame = bps * ch;
  if (!(tag === 1 || tag === 3) || !bps || !ch) throw new Error("unsupported WAV format");
  const nfr = Math.floor((data[1] - data[0]) / frame), x = new Float64Array(nfr);
  for (let f = 0; f < nfr; f++) {
    let acc = 0;
    for (let c = 0; c < ch; c++) {
      const o = data[0] + f * frame + c * bps;
      let s;
      if (tag === 3) s = bps === 4 ? v.getFloat32(o, true) : v.getFloat64(o, true);
      else if (bps === 2) s = v.getInt16(o, true) / 32768;
      else if (bps === 3) s = (((d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) << 8) >> 8) / 8388608;
      else if (bps === 4) s = v.getInt32(o, true) / 2147483648;
      else s = (d[o] - 128) / 128;
      acc += s;
    }
    x[f] = acc / ch;
  }
  return { sr, x };
}

/* gen_samples.resample: moving average over the ratio, then linear interpolation */
function resample(x, sr, to) {
  if (sr === to) return Array.from(x);
  if (sr > to) {
    const k = Math.max(1, pyRound(sr / to));
    if (k > 1) {
      const y = new Array(x.length);
      for (let i = 0; i < x.length; i++) { let s = 0; for (let j = i; j < Math.min(x.length, i + k); j++) s += x[j]; y[i] = s / k; }
      x = y;
    }
  }
  const step = sr / to, out = [];
  let p = 0;
  while (p < x.length - 1) { const i = Math.floor(p), f = p - i; out.push(x[i] * (1 - f) + x[i + 1] * f); p += step; }
  return out;
}
function pyRound(v) { const f = Math.floor(v), r = v - f; return r > 0.5 ? f + 1 : r < 0.5 ? f : (f % 2 ? f + 1 : f); }

/* mono float -> int16, peak normalised to 30000 */
function normalize(x) {
  let pk = 1e-9;
  for (const v of x) pk = Math.max(pk, Math.abs(v));
  return Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.trunc(v / pk * 30000))));
}

/* a trimmed sample: raw (mono float at SMP.RATE) from a to b, a fade of FADE samples at both cut ends
 * (no click where the sound was cut; none at the file's own start and end), normalised */
const FADE = 44;                                     /* 2 ms at 22050 Hz */
function takeSample(raw, a, b) {
  a = Math.max(0, Math.min(raw.length - 1, a | 0));
  b = Math.max(a + 1, Math.min(raw.length, b | 0));
  const x = Float64Array.from(raw.subarray ? raw.subarray(a, b) : raw.slice(a, b));
  const n = Math.min(FADE, x.length >> 1);
  for (let i = 0; i < n; i++) {
    const g = i / n;
    if (a > 0) x[i] *= g;
    if (b < raw.length) x[x.length - 1 - i] *= g;
  }
  return normalize(x);
}

/* a trimming view [v0, v1) of n samples: zoomed by factor (< 1 in) around the fraction at of the
 * view, then moved by pan views; at least 256 samples (~12 ms), inside [0, n) */
function zoomView(n, v0, v1, at, factor, pan) {
  const min = Math.min(n, 256);
  let span = Math.round(Math.max(min, Math.min(n, (v1 - v0) * factor)));
  let c = v0 + at * (v1 - v0) + pan * span;         /* the sample under the pointer stays under it */
  let a = Math.round(c - at * span);
  a = Math.max(0, Math.min(n - span, a));
  return [a, a + span];
}

/* where the sound is: the first and last sample above rel x the peak, with a 5 ms pre-roll and a
 * 20 ms tail; [0, length] for silence */
function autoTrim(raw, rel = 0.02) {
  let pk = 0;
  for (const v of raw) pk = Math.max(pk, Math.abs(v));
  if (!pk) return [0, raw.length];
  const th = pk * rel;
  let a = 0, b = raw.length - 1;
  while (a < raw.length && Math.abs(raw[a]) < th) a++;
  while (b > a && Math.abs(raw[b]) < th) b--;
  return [Math.max(0, a - Math.round(SMP.RATE * 0.005)), Math.min(raw.length, b + 1 + Math.round(SMP.RATE * 0.02))];
}

/* root from a file name like "piano_C4" or "F#3" (C4 = 60), else 60 (sampleio.note_from_name) */
function rootFromName(name) {
  const m = /(?<![A-Za-z])([A-G])([#b]?)(-?\d)(?!\d)/.exec(name);
  if (!m) return 60;
  const n = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (parseInt(m[3], 10) + 1) * 12;
  return Math.max(0, Math.min(127, n));
}

/* zones: [{s: Int16Array (22050 Hz), root, lo?, hi?}] -> {hdr (480 B), data, zones} (sampleio.user_slot) */
function buildSlot(name, zonesIn) {
  const zones = [], parts = [];
  let len = 0;
  for (const z of zonesIn) {
    const e = imaEncode(z.s, 0);
    zones.push({ off: len, n: z.s.length, ls: 0, le: z.s.length - 1, root: z.root, lo: z.lo ?? null, hi: z.hi ?? null, pred: e.pred, idx: e.idx });
    parts.push(e.data);
    len += e.data.length;
  }
  const data = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { data.set(p, o); o += p.length; }
  if (len > SMP.MAX_DATA) throw new Error(`too long: ${len} B (max ${SMP.MAX_DATA} B)`);
  if (!zones.length || zones.length > SMP.MAX_ZONES) throw new Error("1..16 files per slot");
  zones.sort((a, b) => a.root - b.root);
  zones.forEach((z, j) => {
    if (z.lo == null) {
      z.lo = j === 0 ? 0 : Math.floor((zones[j - 1].root + z.root) / 2) + 1;
      z.hi = j === zones.length - 1 ? 127 : Math.floor((z.root + zones[j + 1].root) / 2);
    }
  });
  const hdr = new Uint8Array(SMP.HDR_LEN), v = new DataView(hdr.buffer);
  v.setUint32(0, 0x504D5346, true);
  v.setUint16(4, 1, true);
  hdr[6] = zones.length;
  const nm = String(name).toUpperCase().replace(/[^\x20-\x7E]/g, "").slice(0, 8);
  for (let i = 0; i < nm.length; i++) hdr[8 + i] = nm.charCodeAt(i);
  v.setUint32(16, len, true);
  v.setUint32(20, crc32(data), true);
  const rate = pyRound(SMP.RATE / 44100 * 65536);
  zones.forEach((z, j) => {
    const b = 32 + j * 28;
    [z.off, z.n, z.ls, z.le, rate].forEach((x, k) => v.setUint32(b + k * 4, x >>> 0, true));
    v.setInt16(b + 20, z.root * 16, true);
    v.setInt16(b + 22, z.pred, true);
    hdr[b + 24] = z.idx; hdr[b + 25] = z.lo; hdr[b + 26] = z.hi; hdr[b + 27] = 0;
  });
  return { hdr, data, zones };
}

/* -------------------------------------------------------------- librarian --- */
/* A patch (library entry, user preset):
     {name, engine (index), engineName, p: [P_COUNT values by parameter id, null = unknown],
      pattern: 16 x [note 0..127 (0 rest), flags 1 accent | 2 slide | 4 tie] or null,
      grid: 16 x [lane hits 0..255, their accents] or null (a DRUM sound's 16 steps; then no pattern),
      tags: [], created, modified}

   Library / bank / single-patch file (JSON):
     {
       "format": "felucca-library", "version": 1,
       "kind": "library" | "bank" | "patch",
       "firmware": "FELUCCA 0.5 ...",          device version string when exported ("" if unknown)
       "pCount": 57, "pE0": 49,                 P_COUNT and the first engine parameter id
       "paramLabels": ["LVL", "ATK", ...],      one key per parameter id: the DESC label, "#2", "#3" appended to
                                                a repeated label (PIT, PIT#2), and "E0".."E7" for the engine
                                                parameters (their labels depend on the engine)
       "engines": ["ANALOG", ...],              engine names by index
       "exported": "2026-10-03T12:00:00.000Z",
       "patches": [{ "name", "engine", "engineName", "params": [pCount numbers or null],
                     "pattern": [[note, flags] x 16] or null, "grid": [[hits, accents] x 16] (when there is one),
                     "tags": [...], "created", "modified",
                     "slot": n (bank files only, 0-based) }]
     }
   Reading maps every parameter by its key, so a firmware with other ids (or more parameters) still gets
   the right values; parameters the file does not have are null (left at the engine default). Engines are
   matched by name. The old single-sound file ("felucca-patch" version 1, "Save to file") is read too. */
const LIB = { FORMAT: "felucca-library", VERSION: 1 };

/* parameter keys by id from the instrument DESCs */
function paramKeys(pdesc, pe0, pcount) {
  const seen = {}, out = [];
  for (let i = 0; i < pcount; i++) {
    if (i >= pe0) { out.push("E" + (i - pe0)); continue; }
    const l = (pdesc[i] && pdesc[i].label) || "P" + i;
    seen[l] = (seen[l] || 0) + 1;
    out.push(seen[l] > 1 ? `${l}#${seen[l]}` : l);
  }
  return out;
}
const sameKeys = (a, b) => !!a && !!b && a.length === b.length && a.every((k, i) => k === b[i]);
/* values by fromKeys -> values by toKeys (null where the source has no such key) */
function remapParams(p, fromKeys, toKeys, pe0) {
  if (!fromKeys && toKeys && pe0 && p.length !== toKeys.length) return tailParams(p, toKeys.length, pe0);
  if (!fromKeys || !toKeys || sameKeys(fromKeys, toKeys)) return p.slice();
  const at = new Map(fromKeys.map((k, i) => [k, i]));
  return toKeys.map((k) => (at.has(k) ? p[at.get(k)] ?? null : null));
}

/* values without keys from another firmware: ids below its P_E0 kept their places, its last 8 are E0..E7
   (common ids are only ever appended before P_E0); the rest stay null */
function tailParams(p, n, pe0) {
  const out = Array(n).fill(null), common = Math.max(0, p.length - 8);
  for (let i = 0; i < Math.min(common, pe0); i++) out[i] = p[i] ?? null;
  for (let k = 0; k < 8 && common + k < p.length; k++) out[pe0 + k] = p[common + k] ?? null;
  return out;
}

/* one pattern step as the firmware keeps it (up_pat_norm): a tie has no note, a rest no flags */
const patNorm = (n, f) => (f & 4 ? [0, 4] : [n & 0x7F, n ? f & 3 : 0]);
/* sequencer steps (STEP_GET objects) -> 16-step pattern, as the firmware's UP_STORE does (up_pat_from):
   the first note of a NOTE step, flag 4 for a TIE step */
function patternFromSteps(steps) {
  return Array.from({ length: UP.PAT }, (_, i) => {
    const s = steps[i];
    if (!s) return [0, 0];
    return patNorm(s.time === 0 && s.n ? s.notes[0] : 0, s.time === 1 ? 4 : s.flags);
  });
}
/* pattern -> 16 STEP_SET objects, as the firmware loads one (load_pat16; velocity 96) */
function stepsFromPattern(pat) {
  return Array.from({ length: UP.PAT }, (_, i) => {
    const [n, f] = (pat && pat[i]) || [0, 0];
    return { n: n ? 1 : 0, notes: [n & 0x7F, 0, 0, 0], time: f & 4 ? 1 : n ? 0 : 2, flags: n ? f & 3 : 0, vel: n ? 96 : 0 };
  });
}
const patternUsed = (pat) => !!pat && pat.some((x) => x && x[0]);
/* a DRUM track's first 16 steps -> a grid, as the firmware's UP_STORE stores one (its notes on their lanes) */
const gridFromSteps = (steps) => Array.from({ length: UP.PAT }, (_, i) => (steps[i] ? [stepLanes(steps[i]), stepAccents(steps[i])] : [0, 0]));

function cleanPatch(pt) {
  const now = new Date().toISOString();
  const pat = Array.isArray(pt.pattern) && pt.pattern.length
    ? Array.from({ length: UP.PAT }, (_, i) => { const x = pt.pattern[i]; return Array.isArray(x) ? patNorm(x[0] | 0, x[1] | 0) : [0, 0]; })
    : null;
  const grid = Array.isArray(pt.grid) && pt.grid.length
    ? Array.from({ length: UP.PAT }, (_, i) => { const x = pt.grid[i]; const h = Array.isArray(x) ? x[0] & 255 : 0; return [h, Array.isArray(x) ? x[1] & h : 0]; })
    : null;
  const o = {
    name: String(pt.name ?? "PATCH").slice(0, 32) || "PATCH",
    engine: pt.engine | 0, engineName: String(pt.engineName ?? ""),
    p: Array.from(pt.p || pt.params || [], (v) => (Number.isFinite(v) ? Math.round(v) : null)),
    pattern: patternUsed(grid) ? null : patternUsed(pat) ? pat : null,
    grid: patternUsed(grid) ? grid : null,
    tags: Array.isArray(pt.tags) ? [...new Set(pt.tags.map((x) => String(x).trim()).filter(Boolean))] : [],
    created: pt.created || now, modified: pt.modified || pt.created || now,
  };
  if (Number.isInteger(pt.slot)) o.slot = pt.slot;
  if (Array.isArray(pt.fm6) && pt.fm6.length === FM6.PACKED) o.fm6 = pt.fm6.map((x) => (x | 0) & 127);   /* (a converted */
  if (Array.isArray(pt.fm4)) o.fm4 = pt.fm4.map((v) => (Number.isFinite(v) ? Math.round(v) : null));    /* DIGITAL sound) */
  return o;
}

/* ctx: {keys, engines, firmware, pe0} of the library (the device's when connected) */
function libraryFile(kind, patches, ctx) {
  return {
    format: LIB.FORMAT, version: LIB.VERSION, kind, firmware: ctx.firmware || "",
    pCount: ctx.keys ? ctx.keys.length : 0, pE0: ctx.pe0 ?? null, paramLabels: ctx.keys || [], engines: ctx.engines || [],
    exported: new Date().toISOString(),
    patches: patches.map((x) => {
      const c = cleanPatch(x);
      const o = { name: c.name, engine: c.engine, engineName: c.engineName || (ctx.engines || [])[c.engine] || "",
        params: c.p, pattern: c.pattern, tags: c.tags, created: c.created, modified: c.modified };
      if (c.grid) o.grid = c.grid;
      if (c.fm6) { o.fm6 = c.fm6; if (c.fm4) o.fm4 = c.fm4; }   /* an FM6 sound's own patch (a DIGITAL sound converted: and
                                                         the DIGITAL values) */
      if (Number.isInteger(x.slot)) o.slot = x.slot;
      return o;
    }),
  };
}
/* -> {patches, skipped, keys (the file's, for a library that has none yet)}; throws on a file it cannot read.
   A DIGITAL patch (the engine retired in 1.0) where ctx has no DIGITAL imports as FM6 (fromDigital); a SAMPLE PERC
   one (the set retired after 1.0.2) as DRUM's kit (fromPerc) */
function readLibraryFile(obj, ctx) {
  if (!obj || typeof obj !== "object") throw new Error("not JSON");
  const noFm4 = !(ctx.engines || []).includes("DIGITAL");
  const perc = (pt, pe0) => (pt && fromPerc(pt, ctx.engines, pe0)) || pt;
  const fm4 = (pt, nm, pe0) => (nm === "DIGITAL" && noFm4 ? fromDigital(pt, ctx.engines, pe0) : perc(pt, pe0));
  const engIndex = (name, idx, fileEngines) => {
    const nm = name || (fileEngines || [])[idx];
    if (ctx.engines && ctx.engines.length) {
      if (nm) return ctx.engines.indexOf(nm);
      return idx < ctx.engines.length ? idx : -1;
    }
    return idx;
  };
  if (obj.format === "felucca-patch") {               /* "Save to file": the whole current sound */
    if (!Array.isArray(obj.p) || !Number.isInteger(obj.engine)) throw new Error("felucca-patch without engine / p");
    const digital = obj.engineName === "DIGITAL" && noFm4;
    const e = digital ? 1 : engIndex(obj.engineName, obj.engine);
    if (e < 0) return { patches: [], skipped: 1, keys: null };
    const p = ctx.keys && ctx.pe0 && obj.p.length !== ctx.keys.length ? tailParams(obj.p, ctx.keys.length, ctx.pe0)
      : obj.p.slice(0, ctx.keys ? ctx.keys.length : obj.p.length);
    const pt = fm4({ name: obj.presetName || obj.engineName || "PATCH", engine: e, engineName: obj.engineName, p,
      pattern: Array.isArray(obj.steps) ? patternFromSteps(obj.steps) : null, tags: ["file"] }, obj.engineName,
      ctx.keys && ctx.pe0 ? ctx.pe0 : p.length - 8);
    return pt ? { patches: [cleanPatch(pt)], skipped: 0, keys: null } : { patches: [], skipped: 1, keys: null };
  }
  if (obj.format !== LIB.FORMAT) throw new Error("unknown format");
  if (!(obj.version >= 1)) throw new Error("version");
  if (!Array.isArray(obj.patches)) throw new Error("no patches");
  const fileKeys = Array.isArray(obj.paramLabels) && obj.paramLabels.length ? obj.paramLabels.map(String) : null;
  const out = [];
  let skipped = 0;
  for (const x of obj.patches) {
    if (!x || !Array.isArray(x.params)) { skipped++; continue; }
    const nm = x.engineName || (obj.engines || [])[x.engine | 0];
    const digital = nm === "DIGITAL" && noFm4;
    const e = digital ? 1 : engIndex(x.engineName, x.engine | 0, obj.engines);
    if (e < 0) { skipped++; continue; }
    const p = remapParams(x.params, fileKeys, ctx.keys, ctx.pe0);
    const pe0 = ctx.keys && ctx.pe0 ? ctx.pe0 : obj.pE0 ?? p.length - 8;
    const pt = digital ? fromDigital({ ...x, engine: e, p }, ctx.engines, pe0)
      : perc(cleanPatch({ ...x, engine: e, engineName: (ctx.engines || [])[e] || x.engineName || (obj.engines || [])[x.engine], p }), pe0);
    if (!pt) { skipped++; continue; }
    out.push(cleanPatch(pt));
  }
  return { patches: out, skipped, keys: fileKeys };
}

/* device side; rq(r, opt) -> reply args (Link.request), info from INFO */
const FLASH_OPT = { timeout: 2500, retries: 0 };
const presetPatches = (info) => !!(info && info.fm6 && info.fm6.caps & 2);   /* user presets carry FM6 patches (1.0.3) */
const bank = {
  async list(rq) {
    const first = parse[CMD.UP_LIST](await rq(req.upList(0, UP.LIST_MAX)));
    const slots = first.slots.slice();
    while (slots.length < first.total) {
      const r = parse[CMD.UP_LIST](await rq(req.upList(slots.length, Math.min(UP.LIST_MAX, first.total - slots.length))));
      if (!r.count) break;
      slots.push(...r.slots);
    }
    return { total: first.total, slots };
  },
  /* an FM6 sound's own patch comes with it (fm6: packed) where the firmware keeps one (INFO fm6.caps bit 1) */
  async get(rq, info, slot) {
    const u = parse[CMD.UP_GET](await rq(req.upGet(slot)), info);
    if (u.used && presetPatches(info) && info.engines[u.engine] === "FM6") {
      const g = parse[CMD.FM6_GET](await rq(req.fm6Get(FM6.TARGET.USER, slot)));
      if (!g.rc) u.fm6 = g.packed;
    }
    return u;
  },
  /* -> rc (0 ok); with info, an FM6 sound's patch (pt.fm6) goes with it */
  async put(rq, slot, pt, info) {
    const rc = parse[CMD.UP_PUT](await rq(req.upPut(slot, pt), FLASH_OPT)).rc;
    if (rc || !pt.fm6 || !presetPatches(info) || info.engines[pt.engine] !== "FM6") return rc;
    return parse[CMD.FM6_PUT](await rq(req.fm6Put(FM6.TARGET.USER, slot, pt.fm6), FLASH_OPT)).rc;
  },
  async store(rq, slot, name) { return parse[CMD.UP_STORE](await rq(req.upStore(slot, name), FLASH_OPT)).rc; },
  async load(rq, slot) { return parse[CMD.UP_LOAD](await rq(req.upLoad(slot), { timeout: 1000 })).rc; },
  async erase(rq, slot) { return parse[CMD.UP_ERASE](await rq(req.upErase(slot), FLASH_OPT)).rc; },
};

/* the current sound: DUMP + the first 16 steps */
async function capturePatch(rq, info, name) {
  const dump = parse[CMD.DUMP](await rq(req.dump()), info);
  const steps = [];
  for (let i = 0; i < UP.PAT && i < info.nstep; i++) steps.push(parse[CMD.STEP_GET](await rq(req.stepGet(i))));
  const drum = info.engines[dump.engine] === "DRUM";   /* (a DRUM track that strikes a lane: its grid) */
  let fm6 = null;                                      /* an FM6 track: its own patch (the selected track's) */
  if (info.fm6 && info.engines[dump.engine] === "FM6") {
    const sel = info.ntrk ? parse[CMD.TRACK](await rq(req.track())).sel : 0;
    const g = parse[CMD.FM6_GET](await rq(req.fm6Get(FM6.TARGET.TRACK, sel)));
    if (!g.rc) fm6 = g.packed;
  }
  return { patch: cleanPatch({ name, engine: dump.engine, engineName: info.engines[dump.engine], p: dump.p, pattern: patternFromSteps(steps),
    grid: drum ? gridFromSteps(steps) : null, fm6 }), dump, steps };
}

/* the track's own parameters, which no sound load changes (ui.c param_kept): LEVEL, the ARP and ARP 2 pages,
   SCL, LEN DIV SWING GATE (17..32), PAN, MUTE, the SLICER (45..48); with P_E0 83 the chord keys CHRD VOIC (81, 82:
   E0 E1 of the 89-parameter firmware) */
const TRACK_OWN = new Set([0, 39, 40, ...Array.from({ length: 16 }, (_, i) => 17 + i), 45, 46, 47, 48]);
const P_CHORD = [81, 82];                          /* core.h P_CHRD, P_VOIC (since P_COUNT 91, P_E0 83) */
const trackOwn = (i, pe0) => TRACK_OWN.has(i) || (pe0 >= 83 && P_CHORD.includes(i));
/* play a patch without writing flash, as UP_LOAD would load it: the sound only. SET the engine (G_ENGSEL:
   engine defaults and its first preset), then every instrument parameter that differs, except the track's
   own (TRACK_OWN). The steps are never touched. The device keeps a copy of the sound from before (SAVE held
   there = undo) and treats the SETs right after G_ENGSEL as part of this load (EDITOR_PROTOCOL.md "undo").
   opt: {gEng: G_ENGSEL id, progress(i, n)} */
async function auditionPatch(rq, info, pt, opt = {}) {
  await rq(req.set(1, opt.gEng ?? 20, pt.engine));
  const dump = parse[CMD.DUMP](await rq(req.dump()), info);
  const n = Math.min(info.pcount, pt.p.length);
  for (let i = 0; i < n; i++) {
    const v = pt.p[i];
    if (opt.progress) opt.progress(i, n);
    if (v == null || v === dump.p[i] || trackOwn(i, info.pe0)) continue;
    await rq(req.set(0, i, v));
  }
  if (pt.fm6 && info.fm6)                         /* a converted DIGITAL sound: its own FM6 patch on the track */
    await rq(req.fm6Put(FM6.TARGET.TRACK, opt.track ?? 0, pt.fm6));
  return {};
}

/* WATCH on (asking for TRACK_CHANGED too): false when the firmware does not know it (older than protocol v2),
   else 1, or 3 when it also has TRACK_PARAM / TRACK_CHANGED (protocol v4) */
async function startWatch(rq) {
  try { const on = parse[CMD.WATCH](await rq(req.watch(3), { timeout: 300, retries: 1, quiet: true })).on; return on & 1 ? on & 3 : false; }
  catch (e) { if (e.message === "closed") throw e; return false; }
}

/* ------------------------------------------------------------ mixer (v3) --- */
/* The TRACKS page in the editor: TRACK (engine, preset, level, mute, armed of all four) and TRACK_DUMP
   of each track for its P_PAN. Level and mute go through TRACK_MIX (any track). Pan: TRACK_PARAM (v4, any track); with v3 firmware a plain SET, which reaches only the
   selected track: another track is selected for it and the selection is put back (TRACK pushes no
   RELOAD). ids: {pan: P_PAN id} */
const mixer = {
  async read(rq, info, ids) {
    const tr = parse[CMD.TRACK](await rq(req.track()));
    for (let i = 0; i < tr.ntrk; i++) {
      const d = parse[CMD.TRACK_DUMP](await rq(req.trackDump(i)), info);
      tr.tracks[i].pan = ids.pan == null ? null : d.p[ids.pan];
    }
    return tr;
  },
  /* -> {track, level, mute} as the device has them now */
  async setMix(rq, track, level, mute, opt) { return parse[CMD.TRACK_MIX](await rq(req.trackMix(track, level, mute), opt)); },
  /* -> the pan value after clamping. v4: TRACK_PARAM, the selection stays */
  async setPan(rq, track, sel, panId, v, v4) {
    if (v4) return parse[CMD.TRACK_PARAM](await rq(req.trackParam(track, panId, v), { key: "pan:" + track })).value;
    if (track === sel) return parse[CMD.SET](await rq(req.set(0, panId, v))).value;
    await rq(req.track(track));
    try { return parse[CMD.SET](await rq(req.set(0, panId, v))).value; }
    finally { await rq(req.track(sel)).catch(() => {}); }
  },
};

/* ------------------------------------------------------------ mock device --- */
/* Implements the protocol like felucca/src/editor.c, with tables copied from params.c
   and the engine sources (test_web.mjs checks them against the firmware's, felucca/host/descdump.c). Used with ?mock=1 (add &legacy=1 for a firmware without cmds 16..26).
   opt: {legacy: no user bank / WATCH, v3: no TRACK_PARAM / TRACK_CHANGED (firmware 0.8),
         auto: false = no simulated knobs (tests drive sim.*),
         watchMs: how long WATCH lasts after the last request (3000), slots: user bank size (32)} */
/* ------------------------------------------------------------------- FM6 --- */
/* The FM6 engine's patches (eng_fm6.c, EDITOR_PROTOCOL.md "FM6 patches"): the generic 6-operator voice.
   voice: 155 bytes, 6 x 21 operator bytes (the sixth operator first, as the format has them), then 19 voice bytes
   and a 10-character name. packed: the 128-byte record of a 32-voice bank (every byte 7-bit). SysEx files: a
   single voice (F0 43 0n 00 01 1B, 155 bytes, checksum, F7: 163 bytes) or 32 packed voices (F0 43 0n 09 20 00,
   4096 bytes, checksum, F7: 4104 bytes); parseSysex also reads the variants real files have (see there). */
const FM6 = (() => {
  /* per operator byte: name, highest value; then the voice bytes */
  const OP = [["R1", 99], ["R2", 99], ["R3", 99], ["R4", 99], ["L1", 99], ["L2", 99], ["L3", 99], ["L4", 99],
    ["BP", 99], ["LD", 99], ["RD", 99], ["LC", 3], ["RC", 3], ["RS", 7], ["AMS", 3], ["KVS", 7], ["OL", 99],
    ["MODE", 1], ["FC", 31], ["FF", 99], ["DET", 14]];
  const VOICE = [["PR1", 99], ["PR2", 99], ["PR3", 99], ["PR4", 99], ["PL1", 99], ["PL2", 99], ["PL3", 99], ["PL4", 99],
    ["ALG", 31], ["FB", 7], ["OKS", 1], ["LFS", 99], ["LFD", 99], ["LPMD", 99], ["LAMD", 99], ["LKS", 1], ["LFW", 5],
    ["LPMS", 7], ["TRNSP", 48]];
  const OPI = Object.fromEntries(OP.map(([n], i) => [n, i])), VI = Object.fromEntries(VOICE.map(([n], i) => [n, 126 + i]));
  const NAME = 145, SIZE = 155, PACKED = 128;
  const max = (i) => (i < 126 ? OP[i % 21][1] : i < NAME ? VOICE[i - 126][1] : 126);
  /* byte i of operator n (1..6) */
  const at = (n, field) => (6 - n) * 21 + OPI[field];
  function sanitize(v) {
    const o = Uint8Array.from(v.slice(0, SIZE));
    for (let i = 0; i < SIZE; i++) o[i] = i >= NAME ? (o[i] < 32 || o[i] > 126 ? 32 : o[i]) : Math.min(o[i], max(i));
    return o;
  }
  function unpack(b) {                            /* eng_fm6.c fm6_unpack */
    const v = new Uint8Array(SIZE);
    for (let k = 0; k < 6; k++) {
      const o = k * 17, d = k * 21;
      for (let i = 0; i < 11; i++) v[d + i] = b[o + i] & 127;
      v[d + 11] = b[o + 11] & 3; v[d + 12] = b[o + 11] >> 2 & 3; v[d + 13] = b[o + 12] & 7; v[d + 20] = b[o + 12] >> 3 & 15;
      v[d + 14] = b[o + 13] & 3; v[d + 15] = b[o + 13] >> 2 & 7; v[d + 16] = b[o + 14] & 127; v[d + 17] = b[o + 15] & 1;
      v[d + 18] = b[o + 15] >> 1 & 31; v[d + 19] = b[o + 16] & 127;
    }
    for (let i = 0; i < 9; i++) v[126 + i] = b[102 + i] & 127;
    v[134] &= 31; v[135] = b[111] & 7; v[136] = b[111] >> 3 & 1;
    for (let i = 0; i < 4; i++) v[137 + i] = b[112 + i] & 127;
    v[141] = b[116] & 1; v[142] = b[116] >> 1 & 7; v[143] = b[116] >> 4 & 7; v[144] = b[117] & 127;
    for (let i = 0; i < 10; i++) v[NAME + i] = b[118 + i] & 127;
    return sanitize(v);
  }
  function pack(v) {                              /* eng_fm6.c fm6_pack */
    const b = new Array(PACKED).fill(0);
    for (let k = 0; k < 6; k++) {
      const o = k * 17, d = k * 21;
      for (let i = 0; i < 11; i++) b[o + i] = v[d + i] & 127;
      b[o + 11] = (v[d + 11] & 3) | (v[d + 12] & 3) << 2; b[o + 12] = (v[d + 13] & 7) | (v[d + 20] & 15) << 3;
      b[o + 13] = (v[d + 14] & 3) | (v[d + 15] & 7) << 2; b[o + 14] = v[d + 16] & 127;
      b[o + 15] = (v[d + 17] & 1) | (v[d + 18] & 31) << 1; b[o + 16] = v[d + 19] & 127;
    }
    for (let i = 0; i < 9; i++) b[102 + i] = v[126 + i] & 127;
    b[110] &= 31; b[111] = (v[135] & 7) | (v[136] & 1) << 3;
    for (let i = 0; i < 4; i++) b[112 + i] = v[137 + i] & 127;
    b[116] = (v[141] & 1) | (v[142] & 7) << 1 | (v[143] & 7) << 4; b[117] = v[144] & 127;
    for (let i = 0; i < 10; i++) b[118 + i] = v[NAME + i] & 127;
    return b;
  }
  const name = (v) => String.fromCharCode(...v.slice(NAME, NAME + 10)).replace(/\s+$/, "");
  function setName(v, s) {
    const t = String(s).toUpperCase().replace(/[^\x20-\x7E]/g, " ").slice(0, 10).padEnd(10, " ");
    for (let i = 0; i < 10; i++) v[NAME + i] = t.charCodeAt(i);
    return v;
  }
  const checksum = (a) => (128 - (a.reduce((s, x) => s + x, 0) & 127)) & 127;
  /* every voice in a file's bytes, tolerant of what real files have:
     - SysEx F0 43 0n 00 xx xx (one voice, 155 bytes) and F0 43 0n 09 xx xx (32 packed voices, 4096 bytes): the byte
       count is not checked (some tools write 09 10 00, i.e. 0x1000 as two plain bytes); the payload is taken right
       after the 6-byte header whatever follows it: a checksum or not, F7 or not, a stray byte, the next F0;
       a message cut short (EOF, or a byte >= 0x80 inside it) keeps its whole voices (the name may be cut: blanks);
     - several messages in one file, junk before / between / after them;
     - the format's other blocks (manufacturer 43h: supplements, performances, 4-operator voices, universal "LM  ..." blocks) and other
       makers' messages are skipped and counted;
     - raw data without SysEx: 4096 x n bytes (banks), 155 (one voice) or 128 bytes (one packed voice).
     -> {voices: [{name, v}], badSum: messages with a wrong checksum (still read), short: messages cut short,
         skipped: other messages, kinds: what the skipped ones were ("fm4" 4-operator voices, "other43" the format's other
         blocks, "universal", "maker:XX" another manufacturer id), sysex: F0 seen} */
  function parseSysex(bytes) {
    const d = Uint8Array.from(bytes), voices = [], kinds = [];
    let badSum = 0, short = 0, skipped = 0;
    const add = (v) => voices.push({ v, name: name(v) });
    const kind = (k) => { skipped++; if (!kinds.includes(k)) kinds.push(k); };
    const sysex = d.includes(0xF0);
    if (d[0] !== 0xF0 && !sysex) {
      if (d.length && d.length % 4096 === 0) {
        for (let o = 0; o < d.length; o += 128) add(unpack(d.subarray(o, o + 128)));
      } else if (d.length === SIZE) add(sanitize(d));
      else if (d.length === PACKED) add(unpack(d));
      return { voices, badSum, short, skipped, kinds, sysex };
    }
    for (let i = 0; i < d.length; i++) {
      if (d[i] !== 0xF0) continue;
      const id = d[i + 1], st = d[i + 2], f = d[i + 3];
      if (id === 0x43 && st !== undefined && (st & 0xF0) === 0 && (f === 0 || f === 9) && i + 6 <= d.length) {
        const want = f === 0 ? SIZE : 4096, s = i + 6;
        let e = s;
        while (e < d.length && e < s + want && d[e] < 0x80) e++;
        const data = d.subarray(s, e);
        if (data.length < want) short++;
        else if (e < d.length && d[e] < 0x80 && checksum(data) !== d[e]) badSum++;
        if (f === 0) {
          if (data.length >= NAME) { const v = new Uint8Array(SIZE); v.set(data); add(sanitize(v)); }
        } else {
          for (let o = 0; o + 118 <= data.length; o += 128) {    /* whole voices, and one cut in its name (at 118) */
            const pk = new Uint8Array(128); pk.set(data.subarray(o, o + 128)); add(unpack(pk));
          }
        }
        i = e - 1;                      /* on to the next F0 (the checksum, F7, junk are passed over) */
        continue;
      }
      if (id === 0x43) kind(f === 3 || f === 4 ? "fm4" : "other43");
      else if (id === 0x7E || id === 0x7F) kind("universal");
      else if (id !== undefined && id < 0x80) kind("maker:" + (id === 0 ? [0, d[i + 2], d[i + 3]] : [id])
        .map((x) => (x ?? 0).toString(16).toUpperCase().padStart(2, "0")).join(" "));
    }
    return { voices, badSum, short, skipped, kinds, sysex };
  }
  function singleSysex(v, ch = 0) {
    const data = Array.from(sanitize(v));
    return Uint8Array.from([0xF0, 0x43, ch & 15, 0, 0x01, 0x1B, ...data, checksum(data), 0xF7]);
  }
  function bankSysex(voices, ch = 0) {            /* up to 32 voices (155 bytes each), the rest the init voice */
    const data = [];
    for (let k = 0; k < 32; k++) data.push(...(voices[k] ? pack(voices[k]) : INIT_PK));
    return Uint8Array.from([0xF0, 0x43, ch & 15, 9, 0x20, 0, ...data, checksum(data), 0xF7]);
  }
  /* the 32 algorithms (msfa's tables; fm6_core.c FM6_ALG): per operator, the sixth first */
  const ALG = [[0xc1, 0x11, 0x11, 0x14, 0x01, 0x14], [0x01, 0x11, 0x11, 0x14, 0xc1, 0x14], [0xc1, 0x11, 0x14, 0x01, 0x11, 0x14],
    [0xc1, 0x11, 0x94, 0x01, 0x11, 0x14], [0xc1, 0x14, 0x01, 0x14, 0x01, 0x14], [0xc1, 0x94, 0x01, 0x14, 0x01, 0x14],
    [0xc1, 0x11, 0x05, 0x14, 0x01, 0x14], [0x01, 0x11, 0xc5, 0x14, 0x01, 0x14], [0x01, 0x11, 0x05, 0x14, 0xc1, 0x14],
    [0x01, 0x05, 0x14, 0xc1, 0x11, 0x14], [0xc1, 0x05, 0x14, 0x01, 0x11, 0x14], [0x01, 0x05, 0x05, 0x14, 0xc1, 0x14],
    [0xc1, 0x05, 0x05, 0x14, 0x01, 0x14], [0xc1, 0x05, 0x11, 0x14, 0x01, 0x14], [0x01, 0x05, 0x11, 0x14, 0xc1, 0x14],
    [0xc1, 0x11, 0x02, 0x25, 0x05, 0x14], [0x01, 0x11, 0x02, 0x25, 0xc5, 0x14], [0x01, 0x11, 0x11, 0xc5, 0x05, 0x14],
    [0xc1, 0x14, 0x14, 0x01, 0x11, 0x14], [0x01, 0x05, 0x14, 0xc1, 0x14, 0x14], [0x01, 0x14, 0x14, 0xc1, 0x14, 0x14],
    [0xc1, 0x14, 0x14, 0x14, 0x01, 0x14], [0xc1, 0x14, 0x14, 0x01, 0x14, 0x04], [0xc1, 0x14, 0x14, 0x14, 0x04, 0x04],
    [0xc1, 0x14, 0x14, 0x04, 0x04, 0x04], [0xc1, 0x05, 0x14, 0x01, 0x14, 0x04], [0x01, 0x05, 0x14, 0xc1, 0x14, 0x04],
    [0x04, 0xc1, 0x11, 0x14, 0x01, 0x14], [0xc1, 0x14, 0x01, 0x14, 0x04, 0x04], [0x04, 0xc1, 0x11, 0x14, 0x04, 0x04],
    [0xc1, 0x14, 0x04, 0x04, 0x04, 0x04], [0xc4, 0x04, 0x04, 0x04, 0x04, 0x04]];
  /* operators 1..6 that are carriers (on the output bus), and the one with the feedback, of algorithm a (0..31) */
  const carriers = (a) => [1, 2, 3, 4, 5, 6].filter((n) => !(ALG[a & 31][6 - n] & 3));
  const feedbackOp = (a) => [1, 2, 3, 4, 5, 6].find((n) => (ALG[a & 31][6 - n] & 0xc0) === 0xc0);
  /* an operator's frequency as text: x ratio, or Hz for a fixed one (msfa note osc_freq) */
  function freqText(v, n) {
    const fc = v[at(n, "FC")], ff = v[at(n, "FF")];
    if (v[at(n, "MODE")]) return (10 ** ((fc & 3) + ff / 100)).toPrecision(4) + " Hz";
    return "x" + ((fc ? fc : 0.5) * (1 + ff / 100)).toFixed(2);
  }
  const INIT_PK = [99,99,99,99,99,99,99,0,39,0,0,0,56,0,0,2,0,99,99,99,99,99,99,99,0,39,0,0,0,56,0,0,2,0,99,99,99,99,99,99,99,0,39,0,0,0,56,0,0,2,0,99,99,99,99,99,99,99,0,39,0,0,0,56,0,0,2,0,99,99,99,99,99,99,99,0,39,0,0,0,56,0,0,2,0,99,99,99,99,99,99,99,0,39,0,0,0,56,0,99,2,0,99,99,99,99,50,50,50,50,0,8,35,0,0,0,49,24,73,78,73,84,32,86,79,73,67,69];
  const FACTORY_PK = [
    [95,40,30,60,99,80,0,0,39,0,0,0,56,12,52,2,0,95,30,20,60,99,90,0,0,39,0,0,0,48,4,78,2,0,97,62,40,60,99,60,0,0,39,0,0,0,59,24,68,28,0,95,20,20,50,99,95,0,0,39,0,0,0,66,8,90,2,0,95,50,35,78,99,75,0,0,39,0,0,0,59,28,58,2,0,96,25,25,67,99,75,0,0,39,0,0,0,59,8,98,2,0,99,99,99,99,50,50,50,50,4,11,34,33,0,0,41,24,84,73,78,69,32,69,80,32,32,32],   /* TINE EP */
    [99,60,40,45,99,50,0,0,39,0,0,0,56,0,60,2,0,99,60,40,45,99,50,0,0,39,0,0,0,40,0,78,10,40,99,50,30,40,99,60,0,0,39,0,0,0,56,12,70,10,0,99,45,30,40,99,70,0,0,39,0,0,0,72,4,84,4,38,99,35,25,35,99,70,0,0,39,0,0,0,56,12,78,6,50,99,40,25,35,99,80,0,0,39,0,0,0,56,4,96,2,0,99,99,99,99,50,50,50,50,4,8,35,0,0,0,1,24,71,76,65,83,83,32,66,69,76,76],   /* BELL */
    [99,99,99,99,99,99,99,0,39,0,0,0,56,0,0,2,0,99,99,99,99,99,99,99,0,39,0,0,0,56,0,0,2,0,99,72,50,75,99,65,40,0,39,0,0,0,56,24,78,4,0,99,55,40,75,99,70,50,0,39,0,0,0,64,4,80,2,0,99,60,40,75,99,72,55,0,39,0,0,0,56,20,80,2,0,99,40,30,75,99,85,70,0,39,0,0,0,56,8,99,2,0,99,99,99,99,50,50,50,50,4,8,35,0,0,0,1,24,82,79,85,78,68,32,66,65,83,83],   /* FM BASS */
    [52,50,40,60,99,85,82,0,39,0,0,0,56,8,72,2,0,62,50,40,60,99,92,90,0,39,0,0,0,40,4,88,2,0,50,50,40,60,99,88,85,0,39,0,0,0,56,12,78,2,0,62,50,40,60,99,92,90,0,39,0,0,0,72,4,92,2,0,55,50,40,60,99,88,85,0,39,0,0,0,56,12,80,2,0,65,50,40,60,99,92,90,0,39,0,0,0,56,4,98,2,0,80,60,99,60,46,50,50,50,4,13,33,50,6,0,57,24,66,82,65,83,83,32,83,69,67,84],   /* BRASS */
    [35,30,40,40,85,90,85,0,39,0,0,0,56,0,50,2,0,38,30,40,40,99,95,90,0,39,0,0,0,56,0,80,4,0,30,25,40,40,80,90,85,0,39,0,0,0,56,4,55,4,0,40,30,40,40,99,95,90,0,39,0,0,0,80,0,92,2,0,35,30,40,40,85,90,80,0,39,0,0,0,56,4,60,2,0,40,30,40,40,99,95,90,0,39,0,0,0,40,0,92,2,0,99,99,99,99,50,50,50,50,4,10,30,60,4,0,41,24,83,79,70,84,32,80,65,68,32,32],   /* PAD */
    [99,99,99,99,99,99,99,0,39,0,0,0,56,0,0,2,0,99,99,99,99,99,99,99,0,39,0,0,0,56,0,0,2,0,99,80,50,60,99,0,0,0,39,0,0,0,59,12,45,2,0,99,70,50,60,99,0,0,0,39,0,0,0,59,12,72,8,0,99,75,50,60,99,0,0,0,39,0,0,0,59,20,70,8,0,99,52,40,55,99,0,0,0,39,0,0,0,58,8,99,2,0,99,99,99,99,50,50,50,50,4,8,35,0,0,0,1,24,87,79,79,68,32,66,65,82,83,32],   /* MARIMBA */
    [99,99,99,85,99,99,99,0,39,0,0,0,56,0,72,2,50,99,99,99,85,99,99,99,0,39,0,0,0,56,0,78,8,0,99,99,99,85,99,99,99,0,39,0,0,0,56,0,76,6,0,99,99,99,85,99,99,99,0,39,0,0,0,56,0,86,4,0,99,99,99,85,99,99,99,0,39,0,0,0,56,0,84,0,0,99,99,99,85,99,99,99,0,39,0,0,0,56,0,90,2,0,99,99,99,99,50,50,50,50,31,8,60,0,3,0,57,24,68,82,65,87,66,65,82,83,32,32],   /* ORGAN */
    [99,99,99,99,99,99,99,0,39,0,0,0,56,0,0,2,0,99,99,99,99,99,99,99,0,39,0,0,0,56,0,0,2,0,99,75,40,60,99,30,0,0,39,0,0,0,58,12,68,2,0,99,60,40,60,99,30,0,0,39,0,0,0,66,8,74,4,0,99,70,40,60,99,40,0,0,39,0,0,0,58,16,76,6,0,99,45,30,60,99,60,0,0,39,0,0,0,58,8,98,2,0,99,99,99,99,50,50,50,50,4,8,35,0,0,0,1,24,78,89,76,79,78,32,80,73,67,75],   /* PLUCK */
  ];
  const init = () => unpack(INIT_PK);
  const factory = (k) => unpack(FACTORY_PK[k]);
  return { OP, VOICE, OPI, VI, NAME, SIZE, PACKED, max, at, sanitize, unpack, pack, name, setName, checksum, parseSysex,
    singleSysex, bankSysex, ALG, carriers, feedbackOp, freqText, INIT_PK, FACTORY_PK, init, factory,
    TARGET: { TRACK: 0, BANK: 1, FACTORY: 2, USER: 3 } };
})();

/* ----------------------------------------------------------------- DIGITAL --- */
/* DIGITAL (engine 1, four-operator FM) was replaced by FM6 (1.0): the firmware keeps engine 1 reserved (its name
   "-"; a FELUCCA_FM4=1 build has DIGITAL back) and turns every DIGITAL sound into an FM6 one with a patch of its own
   (src/fm4_convert.c). This is the same conversion (test_web.mjs: == the firmware's, build/host/desc.json "FM4"), for
   library files and device slots of DIGITAL sounds. convert(p, pe0): p the values as DIGITAL has them (null: its
   defaults), P_E0 at pe0 (the OP ENV values at 61..80 when pe0 >= 81) -> {p: FM6's (the macros neutral, PTCH the
   nearest factory patch, the OP ENV values their defaults), voice: the 155-byte patch, preset: FM6's that covers it} */
const FM4 = (() => {
  const P = (name, e, env, fenv, mono, fx, pat) => ({ name, e, env, fenv, mono, fx, pat });
  const PRESETS = [   /* src/fm4_convert.c DIGITAL_PRESETS (fx: the sends) */
    P("E.PIANO", [4, 1, 1, 14, 70, 55, 0, 0], [0, 80, 40, 60], 0, 0, [0, 50, 25, 35], 6),
    P("BELL", [4, 8, 1, 4, 90, 70, 0, 0], [0, 95, 0, 85], 0, 0, [0, 0, 30, 70], 7),
    P("BASS", [0, 1, 1, 1, 48, 40, 8, 0], [0, 60, 70, 25], 0, 1, [0, 0, 10, 10], 2),
    P("BRASS", [0, 1, 1, 1, 70, 40, 20, 0], [40, 70, 100, 40], 20, 0, [0, 20, 20, 40], 6),
    P("ORGAN", [7, 2, 3, 4, 0, 0, 0, 0], [2, 60, 127, 20], 0, 0, [10, 40, 0, 30], 6),
    P("PAD", [5, 2, 1, 3, 40, 90, 10, 0], [80, 90, 110, 95], 0, 0, [0, 60, 30, 70], 5),
    P("MARIMBA", [4, 4, 1, 1, 60, 30, 0, 0], [0, 80, 0, 60], 0, 0, [0, 0, 25, 40], 3),
    P("FUNK KEY", [3, 1, 3, 5, 90, 25, 20, 0], [0, 45, 30, 30], 0, 0, [0, 20, 30, 20], 6)];
  const TO_FM6 = [0, 1, 2, 3, 6, 4, 5, 7];        /* DIGITAL preset k -> the FM6 preset (its PTCH) covering it */
  const ALG = [[0, [3, 4, 5, 6], [1, 1, 1, 1]], [13, [3, 4, 5, 6], [1, 1, 2, 2]], [7, [3, 5, 6, 4], [1, 2, 1, 2]],
    [6, [3, 4, 5, 6], [1, 2, 2, 1]], [4, [1, 2, 5, 6], [2, 1, 2, 1]], [21, [3, 4, 5, 6], [3, 3, 3, 1]],
    [28, [1, 2, 5, 6], [3, 3, 3, 1]], [31, [1, 2, 3, 6], [4, 4, 4, 4]]];
  const MUTE = -100000, FB_NOISE = 20, FB_LIFT = 768, ATK = 1, DEC = 2, SUS = 3, REL = 4, ED_FLT = 5, OPENV = 61;
  const EDEF = [0, 1, 1, 1, 60, 60, 0, 0], TDEF = { 1: 10, 2: 70, 3: 90, 4: 60, 5: 0 };
  const MS10 = Array.from({ length: 128 }, (_, v) => Math.round(10 * 10000 ** (v / 127)));   /* TIME_MS_X10 */
  const LUT = [0, 5, 9, 13, 17, 20, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 42, 43, 45, 46];
  const scaleout = (l) => (l >= 20 ? 28 + l : LUT[l < 0 ? 0 : l]);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const div = (a, b) => Math.trunc(a / b);
  function lg(x) {                                 /* 256 log2(x) (fm4_lg) */
    if (!x) return MUTE;
    let n = 0;
    while (n < 31 && Math.floor(x / 2 ** (n + 1))) n++;
    const f = (n >= 8 ? Math.floor(x / 2 ** (n - 8)) : x * 2 ** (8 - n)) & 255;
    return n * 256 + f + Math.floor(f * (256 - f) * 89 / 65536);
  }
  const ms = (q) => (q ? lg(q) - 3840 : MUTE);
  const samples = (v) => Math.floor(MS10[v & 127] * 441 / 100);
  function rate(per) {
    const lt = lg(per < 1 ? 1 : per);
    let best = 0, bd = Infinity;
    for (let r = 0; r < 100; r++) {
      const q = (r * 41) >> 6, d = Math.abs(lg(Math.floor((1 << (22 - (q >> 2))) / (4 + (q & 3)))) - lt);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }
  const fall = (t, drop) => (drop <= 0 ? (drop === MUTE ? rate(div(t * 100, 664)) : 99) : rate(div(t * 111, drop)));
  function nearestLevel(m, f) {
    if (m <= MUTE) return 0;
    let best = 0, bd = Infinity;
    for (let l = 0; l < 100; l++) { const d = Math.abs(f(l) - m); if (d < bd) { bd = d; best = l; } }
    return best;
  }
  const level = (m) => nearestLevel(m, (l) => ((scaleout(l) >> 1) << 6) - 4032);
  const outlevel = (m) => nearestLevel(m, (l) => (scaleout(l) << 5) - 4064);
  function nearest(e) {
    let best = 0, bd = Infinity;
    PRESETS.forEach((pr, k) => {
      let d = ((e[0] & 7) !== pr.e[0]) * 1000;
      for (let i = 1; i < 7; i++) d += Math.abs(e[i] - pr.e[i]) * (i < 4 ? 8 : 1);
      if (d < bd) { bd = d; best = k; }
    });
    return best;
  }
  function convert(pin, pe0 = pin.length - 8) {
    const p = pin.slice(), v = new Array(156).fill(0), op = pe0 >= 81;
    const g = (i, d) => (p[i] == null ? d : p[i]);
    const ev = Array.from({ length: 8 }, (_, i) => g(pe0 + i, EDEF[i]));
    const tv = (i) => g(i, TDEF[i]);
    const alg = ev[0] & 7, near = nearest(ev);
    const idx = clamp(ev[4], 0, 127), fenv = clamp(tv(ED_FLT), -64, 63), sus = clamp(tv(SUS), 0, 127);
    const ipk = clamp(idx + fenv, 0, 127), isus = clamp(div(idx, 4) + div(fenv * sus, 127), 0, 127);
    const tAtt = samples(tv(ATK)), tMod = samples(ev[5]), car = FM6.carriers(ALG[alg][0]);
    let fb = MUTE;
    for (let k = 0; k < 6; k++) { const o = k * 21; v[o] = v[o + 1] = v[o + 2] = v[o + 3] = 99; v[o + 8] = 39; v[o + 18] = 1; v[o + 20] = 7; }
    v[134] = ALG[alg][0];
    for (let k = 0; k < 4; k++) {
      const e = op ? [0, 1, 2, 3, 4].map((i) => g(OPENV + k * 5 + i, i === 2 || i === 4 ? 127 : 0)) : [0, 0, 127, 0, 127];
      const opn = ALG[alg][1][k], share = ALG[alg][2][k], o = (6 - opn) * 21;
      const flat = !e[0] && !e[1] && e[2] === 127 && !e[3];
      const lvl = clamp(e[4], 0, 127) * 258, osus = flat ? 32767 : clamp(e[2], 0, 127) * 258;
      const tOdec = flat || e[2] === 127 ? 0 : e[1] ? samples(e[1]) : 1;
      const tOrel = flat ? 0x7FFFFFFF : e[3] ? samples(e[3]) : 0;
      const r = k ? (ev[k] >>> 0) % 15 : 1;
      let ta, td, tr, msS;
      v[o + 18] = k ? (r === 0 ? 0 : r <= 12 ? r : r === 13 ? 14 : 16) : 1;
      if (car.includes(opn)) {                     /* a carrier: the master envelope x the op's */
        v[o + 16] = outlevel(ms(Math.floor(lvl / share)) + 256 - 96);
        v[o + 15] = 3;
        ta = tAtt;
        if (!flat && e[0] && samples(e[0]) > ta) ta = samples(e[0]);
        const s = Math.floor(sus * 258 * osus / 32768);
        td = Math.max(sus < 127 ? samples(tv(DEC)) : 0, tOdec);
        tr = samples(tv(REL));
        if (!flat) tr = tOrel ? Math.floor((tr >> 5) * (tOrel >> 5) / ((tr >> 5) + (tOrel >> 5) + 1)) << 5 : 0;
        msS = ms(s);
        v[o] = rate(div(ta * 100, 146)); v[o + 4] = 99; v[o + 5] = v[o + 6] = level(msS);
        v[o + 1] = fall(td, msS === MUTE ? MUTE : -msS); v[o + 2] = 99; v[o + 3] = rate(div(tr * 100, 664)); v[o + 7] = 0;
        if (k === 3 && ev[6] && v[o + 16]) {
          const need = ms(Math.floor(ev[6] * 258 * lvl / 32768)) + 256;
          let out = (scaleout(v[o + 16]) << 5) - 4064 + (msS === MUTE ? -2048 : msS);
          if (ev[6] >= FB_NOISE && msS !== MUTE && out < need) {
            out += Math.min(need - out, FB_LIFT);
            v[o + 16] = outlevel(out - msS);
            out = (scaleout(v[o + 16]) << 5) - 4064 + msS;
          }
          fb = need - 256 - out;
        }
      } else {                                     /* a modulator: INDEX through MODDEC x the op's envelope */
        const a = Math.floor(Math.floor(ipk * lvl / 127) / share);
        const m = ipk ? Math.floor(Math.floor(isus * 32767 / ipk) * osus / 32768) : 0;
        let msA = ms(a);
        msS = ms(m);
        if (k === 3 && ev[6] && a) {
          const need = ms(Math.floor(ev[6] * 258 * lvl / 32768)) + 256;
          if (ev[6] >= FB_NOISE && msS !== MUTE && msA + msS < need) {
            const t = msA + msS + Math.min(need - (msA + msS), FB_LIFT);
            if (t <= msA) msS = t - msA;
            else { msS = 0; msA = t > 0 ? 0 : t; }
          }
          fb = need - 256 - (msA + (msS === MUTE ? -2048 : msS));
        }
        v[o + 16] = outlevel(msA); v[o + 15] = a ? 1 : 0;
        ta = fenv > 0 ? div(tAtt * fenv, idx + fenv) : 0;
        if (!flat && e[0] && samples(e[0]) > ta) ta = samples(e[0]);
        td = Math.max(msS < 0 ? (isus < ipk ? tMod : 0) : 0, tOdec);
        v[o] = rate(div(ta * 100, 146)); v[o + 4] = 99; v[o + 5] = v[o + 6] = level(msS);
        v[o + 1] = fall(td, msS === MUTE ? MUTE : -msS); v[o + 2] = 99;
        if (flat) { v[o + 3] = v[o + 1]; v[o + 7] = v[o + 6]; }
        else { v[o + 3] = tOrel ? rate(div(tOrel * 100, 664)) : 99; v[o + 7] = 0; }
      }
    }
    fb += 8 * 256 + 128;                           /* FM6 feedback: deviation = output x 2^(FB - 8) */
    if (ev[6] && fb > 0) v[135] = Math.min(div(fb, 256), 7);
    for (let k = 0; k < 4; k++) { v[126 + k] = 99; v[130 + k] = 50; }
    v[136] = 1; v[137] = 35; v[144] = 24;
    const same = PRESETS.find((pr) => pr.env.every((x, i) => x === tv(ATK + i)) && pr.e.slice(0, 7).every((x, i) => x === ev[i]));
    FM6.setName(v, same ? same.name : `4OP ALG ${alg + 1}`);
    for (let k = 0; k < 7; k++) p[pe0 + k] = 0;
    p[pe0 + 7] = TO_FM6[near];
    if (op) for (let i = 0; i < 20; i++) p[OPENV + i] = i % 5 === 2 || i % 5 === 4 ? 127 : 0;
    return { p, voice: FM6.sanitize(v), preset: TO_FM6[near] };
  }
  /* preset k's values into p (src/fm4_convert.c fm4_preset_values: EDIT, ENV, ENV -> FLT, VOICE, sends, OP ENV) */
  function presetValues(p, k, pe0 = p.length - 8) {
    const pr = PRESETS[k % PRESETS.length];
    pr.e.forEach((x, i) => { p[pe0 + i] = x; });
    pr.env.forEach((x, i) => { p[ATK + i] = x; });
    p[ED_FLT] = pr.fenv; p[37] = pr.mono ? 2 : 0;
    pr.fx.forEach((x, i) => { p[33 + i] = x; });
    if (pe0 >= 81) for (let i = 0; i < 20; i++) p[OPENV + i] = i % 5 === 2 || i % 5 === 4 ? 127 : 0;
    return p;
  }
  return { PRESETS, TO_FM6, ALG, convert, presetValues };
})();
/* a DIGITAL sound for a device / library without DIGITAL (engines: its names; "-" at 1 = reserved) -> the FM6 patch
   that replaces it: {..., engine: FM6's index, engineName "FM6", p, fm6: packed, fm4: the DIGITAL values}; null when
   the engines have no FM6. A device's slot of engine 1 holds such a sound (its record kept: the device converts it) */
function fromDigital(pt, engines, pe0) {
  const fm6 = engines && engines.length ? engines.indexOf("FM6") : 12;
  if (fm6 < 0) return null;
  const src = Array.from(pt.p || pt.params || []);
  const r = FM4.convert(src, pe0 ?? src.length - 8);
  return { ...pt, engine: fm6, engineName: "FM6", p: r.p, params: undefined, fm6: FM6.pack(r.voice), fm4: src };
}
const reservedFm4 = (engines, e) => e === 1 && (engines || [])[1] === "-";   /* a device's slot of a DIGITAL sound */
/* SAMPLE SET 4 was PERC, the GM drum kit (retired after 1.0.2; src/core.h drum_from_perc): a sound of it is the DRUM
   engine with its default kit (eng_drum.c DRUM_PRESETS[0], the same GM key map); the rest of its values stay. engines:
   the names ("SAMPLE", "DRUM"; none: the firmware's indices 4, 10), pe0: P_E0 in its p. -> the DRUM patch, or null when
   pt is no such sound or there is no DRUM. The device converts its own (projects, user presets) the same way */
const PERC_SET = 4, DRUM_KIT_E = [0, 64, 70, 64, 64, 100, 0, 0];
function fromPerc(pt, engines, pe0) {
  const names = engines && engines.length ? engines : null;
  const name = pt.engineName || (names || [])[pt.engine];
  const p = pt.p || pt.params, drum = names ? names.indexOf("DRUM") : 10;
  if ((name ? name !== "SAMPLE" : pt.engine !== 4) || !Array.isArray(p) || drum < 0) return null;
  const e0 = pe0 ?? p.length - 8;
  if (p[e0] !== PERC_SET) return null;
  const q = p.slice();
  DRUM_KIT_E.forEach((v, i) => { q[e0 + i] = v; });
  return { ...pt, engine: drum, engineName: "DRUM", p: q, params: undefined };
}
/* an engine's name to show: the reserved engine 1 holds DIGITAL sounds that play as FM6 */
const engineLabel = (engines, e) => (e === 1 && (engines || [])[1] === "-" ? "FM6" : (engines || [])[e] ?? String(e));

/* the firmware's MENU settings as MENU_DESC lists them (src/menu_items.c, src/editor_menu.c; test_web.mjs: == the
   firmware's, build/host/menu.json): id, name, value names (COLOR: the palettes, UI_PALETTES), the default */
const MENU = [
  { id: 0, name: "COLOR", names: null, def: 0 }, { id: 1, name: "STYLE", names: ["FLAT", "LINE"], def: 0 },
  { id: 2, name: "LARGE", names: ["OFF", "ON"], def: 0 }, { id: 3, name: "ANIM", names: ["ON", "OFF"], def: 0 },
  { id: 4, name: "LEDS", names: ["OFF", "DIM LO", "DIM HI", "INV"], def: 2 },
  { id: 5, name: "HOLD", names: ["0.3 s", "0.4 s", "0.5 s", "0.6 s"], def: 1 },
  { id: 6, name: "KNOB ACCEL", names: ["OFF", "ON"], def: 0 }, { id: 7, name: "FX LATCH", names: ["OFF", "ON"], def: 0 },
  { id: 8, name: "BPM LOCK", names: ["OFF", "ON"], def: 0 }, { id: 9, name: "SPEAKER EQ", names: ["FLAT", "LOWCUT", "BASS+"], def: 0 },
  { id: 10, name: "USB LEVEL", names: ["MASTER", "FIXED"], def: 0 }, { id: 11, name: "USB SERIAL", names: ["ON", "OFF"], def: 0 },
];
/* the MENU settings the device offers, in its menu's order (firmware without them: []); rq as the other readers */
async function readDeviceMenu(rq, info) {
  const items = [];
  for (let i = 0; i < (info.menuCount || 0); i++) {
    const d = parse[CMD.MENU_DESC](await rq(req.menuDesc(i)));
    if (d.id === 127) break;
    items.push(d);
  }
  return items;
}

function makeMockDevice(opt = {}) {
  const NONOFF = ["OFF", "ON"], NDIV = ["1/4", "1/8", "1/16", "1/32", "8T", "16T", "1/2", "1/1", "2BAR", "4BAR"], NGO = ["--", "GO"], NDASH = ["--"];
  const D = (label, fmt, min, max, def, names = null, unit = "") => ({ label, fmt, min, max, def, names, unit });
  const E = (label, names, def) => D(label, F.ENUM, 0, names.length - 1, def, names);
  const MSRC = ["OFF", "LFO", "ENV", "VEL", "KEY", "RAND", "MODW", "AT", "EXPR"];
  const MDST = ["OFF", "PITCH", "CUT", "SHP", "AMP", "PAN", "DIST", "CHO", "DLY", "REV", "RATE", "VIB", "E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"];
  const TP = [
    D("LVL", F.DB, 0, 127, 104),
    D("ATK", F.TIME, 0, 127, 10), D("DEC", F.TIME, 0, 127, 70), D("SUS", F.PCT, 0, 127, 90), D("REL", F.TIME, 0, 127, 60),
    D("FLT", F.BIPCT, -64, 63, 0), D("PIT", F.BIPCT, -64, 63, 0), D("SHP", F.BIPCT, -64, 63, 0), D("FX", F.BIPCT, -64, 63, 0),
    D("RATE", F.LFOHZ, 0, 127, 60), E("WAVE", ["SIN", "TRI", "SAW", "SQR", "S&H"], 0), D("PHS", F.INT, 0, 127, 0), D("FADE", F.TIME, 0, 127, 0),
    D("PIT", F.BIPCT, -64, 63, 0), D("FLT", F.BIPCT, -64, 63, 0), D("SHP", F.BIPCT, -64, 63, 0), D("AMP", F.PCT, 0, 127, 0),
    E("MODE", ["OFF", "UP", "DN", "UPDN", "RND", "ORD", "REPEAT"], 0), E("RATE", NDIV, 2), D("OCT", F.INT, 1, 4, 1), D("GATE", F.PCT, 1, 127, 64),
    D("SWG", F.PCT, 0, 100, 0), D("PROB", F.PCT, 0, 127, 127), E("HOLD", NONOFF, 0), E("ORD", ["NOTE", "PLAY"], 0),
    D("ROOT", F.NOTE, 0, 11, 0), E("SCL", ["CHR", "MAJ", "MIN", "DOR", "MIX", "PEN", "MPEN", "HARM", "PHRY", "LYD", "LOC", "MEL", "BLUES", "WHOLE", "DIMHW", "DIMWH"], 0), E("QNT", ["OFF", "SNAP", "WHITE", "SEQ"], 0), D("TRN", F.SEMI, -24, 24, 0),
    D("LEN", F.STEPS, 1, 64, 16), E("DIV", NDIV, 2), D("SWG", F.PCT, 0, 100, 0), D("GATE", F.PCT, 1, 127, 64),
    D("DST", F.PCT, 0, 127, 0), D("CHO", F.PCT, 0, 127, 0), D("DLY", F.PCT, 0, 127, 0), D("REV", F.PCT, 0, 127, 0),
    E("VCE", ["POLY", "MONO", "LEG", "UNI"], 0), D("GLD", F.TIME, 0, 127, 0), D("PAN", F.BIPCT, -64, 63, 0), E("MUTE", NONOFF, 0),
    E("GLMOD", ["RATE", "TIME"], 0), E("PRIO", ["LAST", "LOW", "HIGH"], 0), E("ALLOC", ["ROT", "REUSE"], 0), D("DTUNE", F.INT, 0, 127, 40),
    E("SLCR", ["OFF", "GATE", "STUT"], 0), D("PAT", F.INT, 1, 16, 1), E("RATE", ["1/8", "1/16", "1/32", "8T", "16T", "32T"], 1), D("DEPTH", F.PCT, 0, 127, 127),
    ...[1, 2, 3, 4].flatMap((k) => [E("SRC" + k, MSRC, 0), E("DST" + k, MDST, 0), D("AMT" + k, F.BIPCT, -64, 63, 0)]),   /* the matrix */
  ];
  const GP = [
    D("BPM", F.BPM, 40, 240, 120), D("SWG", F.PCT, 0, 100, 0), E("CLK", ["INT", "USB", "TRS"], 0), D("TUNE", F.INT, -50, 50, 0),
    E("TIME", NDIV, 1), D("FDBK", F.PCT, 0, 120, 60), D("COLR", F.PCT, 0, 127, 70), D("MIX", F.PCT, 0, 127, 90),
    D("SIZE", F.PCT, 0, 127, 90), D("DAMP", F.PCT, 0, 127, 60), D("CRT", F.LFOHZ, 0, 127, 40), D("CDP", F.PCT, 0, 127, 60),
    E("MIDI", ["USB", "TRS"], 0), E("SYNC", NDASH, 0), E("ROUT", ["CH1-4", "SEL"], 0), D("CPU", F.INT, 0, 0, 0),
    D("SLOT", F.INT, 1, 4, 1), E("NAME", NDASH, 0), E("LOAD", NGO, 0), E("SAVE", NGO, 0),
    E("ENG", ["ANALOG", "-", "PHASE", "LOFI", "SAMPLE", "VOICE", "TRIO", "WHEEL",
      "GRAIN", "PHYS", "DRUM", "NOISE", "FM6", "SLICE"], 0), E("SET", NGO, 0),
    E("CLRSQ", NGO, 0), E("INIT", NGO, 0),
    E("TYPE", ["ROOM", "SPRING"], 0),               /* G_RTYPE (id 24, was G_DRCH): the reverb's model */
    D("-", F.INT, 0, 0, 0), D("-", F.INT, 0, 0, 0),   /* G_DRLVL, G_DRREV: inert since 1.0 */
  ];
  const NONE = D("-", F.INT, 0, 0, 0);
  const RATIO = [".5", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "14", "16"];
  const P = (name, e, env = [10, 70, 90, 60], mono = 0, pat = 0) => ({ name, e, env, mono, pat });
  const ENG = [
    { name: "ANALOG", titles: ["OSC", "FLT"], edit: [E("WAVE", ["SAW", "SQR", "TRI", "SIN", "PWM"], 0), D("DTN", F.INT, 0, 127, 10, null, "ct"), D("MIX", F.PCT, 0, 127, 64),
        D("NOIS", F.PCT, 0, 127, 0), D("CUT", F.CUTOFF, 0, 127, 90), D("RES", F.PCT, 0, 127, 30), D("DRV", F.PCT, 0, 127, 0), D("KTR", F.PCT, 0, 127, 64)],
      presets: [P("SAW LEAD", [0, 12, 64, 0, 90, 30, 10, 64], [4, 70, 100, 50], 1, 4), P("SOFT PAD", [0, 20, 64, 4, 60, 10, 0, 32], [80, 90, 110, 95], 0, 5),
        P("SQR BASS", [1, 0, 0, 0, 50, 70, 40, 64], [0, 60, 40, 30], 1, 2), P("PWM STR", [4, 8, 40, 0, 75, 20, 0, 48], [60, 80, 110, 85], 0, 5),
        P("ACID", [0, 0, 0, 0, 50, 100, 25, 64], [0, 55, 20, 30], 1, 1), P("SINE KEY", [3, 6, 50, 0, 127, 0, 0, 0], [2, 80, 30, 70], 0, 6),
        P("RAVE", [4, 30, 64, 0, 85, 20, 30, 64], [20, 80, 110, 60], 1, 13), P("SUB BASS", [3, 0, 0, 0, 40, 0, 20, 0], [0, 60, 100, 20], 1, 8),
        P("PLUCK", [0, 8, 50, 0, 30, 40, 0, 64], [0, 88, 0, 60], 0, 3), P("BRASS", [0, 10, 64, 0, 45, 20, 10, 64], [35, 70, 90, 45], 0, 6),
        P("WIND", [0, 0, 0, 90, 30, 90, 0, 0], [60, 90, 60, 80], 0, 5), P("STRINGS", [0, 25, 64, 0, 70, 10, 0, 32], [70, 90, 115, 90], 0, 5)] },
    /* 1: reserved (DIGITAL, retired: src/fm4_convert.c ENG_FM4_GONE; its sounds load as FM6, FM4 above) */
    { name: "-", titles: ["-", "-"], edit: [D("-", F.INT, 0, 7, 0), D("-", F.INT, 0, 14, 1), D("-", F.INT, 0, 14, 1),
        D("-", F.INT, 0, 14, 1), D("-", F.PCT, 0, 127, 60), D("-", F.INT, 0, 127, 60), D("-", F.PCT, 0, 127, 0), NONE],
      presets: [] },
    { name: "PHASE", titles: ["PHS", "LINE"], edit: [E("WAVE", ["SAW", "SQR", "PLS", "DSIN", "SPLS", "RSAW", "RTRI", "RTRP"], 0),
        E("WAVE2", ["-", "SAW", "SQR", "PLS", "DSIN", "SPLS", "RSAW", "RTRI", "RTRP"], 0), D("DCW", F.PCT, 0, 127, 60), D("ENV", F.PCT, 0, 127, 64),
        D("DTN", F.INT, 0, 127, 0, null, "ct"), E("LINE", ["MIX", "RING"], 0), D("SUB", F.PCT, 0, 127, 0), NONE],
      presets: [P("BRASS", [0, 0, 30, 90, 0, 0, 0, 0], [8, 70, 90, 40], 0, 6), P("ORGAN", [3, 0, 40, 0, 0, 0, 0, 0], [0, 127, 127, 30], 0, 6),
        P("STRING", [0, 4, 50, 40, 12, 0, 0, 0], [40, 90, 100, 70], 0, 5), P("RESO", [5, 0, 60, 60, 0, 0, 0, 0], [0, 70, 30, 60], 0, 1),
        P("BELL", [6, 0, 80, 50, 0, 0, 0, 0], [0, 95, 0, 90], 0, 7), P("WIRE", [4, 7, 70, 40, 7, 0, 0, 0], [10, 80, 80, 60], 0, 4)] },
    { name: "LOFI", titles: ["CHIP", "MOTN"], edit: [E("CHIP", ["4BIT", "4B/2", "8BIT", "1BIT", "STEP"], 0), E("WAVE", ["PLS", "TRI", "SAW", "NOIS", "WRAM"], 0), D("DUTY", F.INT, 0, 127, 64),
        D("CRSH", F.PCT, 0, 127, 0), D("SWP", F.PCT, 0, 127, 0), D("VIB", F.PCT, 0, 127, 0), E("ARP", ["OFF", "OCT", "MAJ", "MIN"], 0), D("TONE", F.PCT, 0, 127, 127)],
      presets: [P("PULSE LD", [0, 0, 32, 0, 0, 20, 0, 127], [0, 60, 90, 30], 1, 4), P("WAVE BASS", [1, 1, 0, 0, 0, 0, 0, 90], [0, 50, 70, 20], 1, 2),
        P("ARP 8BIT", [2, 0, 96, 0, 0, 0, 2, 110], [0, 60, 80, 40], 0, 13), P("WAVE LEAD", [0, 4, 92, 0, 0, 18, 0, 110], [0, 70, 90, 30], 1, 3),
        P("STEP LEAD", [4, 0, 40, 34, 0, 16, 0, 127], [0, 64, 127, 55], 1, 4)] },
    { name: "SAMPLE", titles: ["SET", "TONE"], edit: [E("SET", ["PIANO", "PIANO", "FLUTE", "SAX", "PIANO", "USR1", "USR2", "USR3"], 0), D("TUNE", F.SEMI, -24, 24, 0), D("BITS", F.INT, 0, 127, 0),
        E("LOOP", NONOFF, 1), D("CUT", F.INT, 0, 127, 127), NONE, D("DRV", F.PCT, 0, 127, 0), NONE],
      presets: [P("PIANO", [0, 0, 0, 1, 127, 0, 0, 0], [0, 127, 127, 70]), P("PIANO", [0, 0, 0, 1, 127, 0, 0, 0], [0, 127, 127, 70]),
        P("FLUTE", [2, 0, 0, 1, 127, 0, 0, 0], [12, 80, 120, 60]), P("SAX", [3, 0, 0, 1, 127, 0, 0, 0], [12, 80, 120, 60])] },
    { name: "VOICE", titles: ["VOWL", "TONE"], edit: [D("VOWL", F.INT, 0, 127, 0), D("VOWL2", F.INT, 0, 127, 64), D("TALK", F.TIME, 0, 127, 0),
        D("SHIFT", F.SEMI, -12, 12, 0), D("BUZZ", F.PCT, 0, 127, 64), D("BRTH", F.PCT, 0, 127, 10), D("Q", F.PCT, 0, 127, 64), D("RAND", F.PCT, 0, 127, 0)],
      presets: [P("CHOIR AAH", [0, 0, 0, 0, 40, 22, 60, 0], [85, 90, 115, 95], 0, 5), P("VOX LEAD", [32, 0, 0, 2, 90, 8, 72, 0], [6, 70, 105, 55], 1, 4),
        P("WOW BASS", [95, 0, 68, 0, 100, 0, 80, 0], [0, 70, 70, 30], 1, 8), P("WHISPER", [0, 95, 88, 3, 50, 120, 50, 0], [50, 90, 110, 90], 0, 5)] },
    { name: "TRIO", titles: ["OSC", "TONE"], edit: [E("WAVE", ["SAW3", "PLS3", "PPT", "SST", "TRI3", "S&T", "P&S", "P+N", "NOIS", "SYNC", "SYNCP", "SYNC3",
        "RING", "RING3", "R+S", "R+SP"], 0), D("INT2", F.SEMI, -24, 24, 0), D("INT3", F.SEMI, -24, 24, -12), D("DTN", F.INT, 0, 50, 6, null, "ct"),
        E("MODE", ["LP", "BP", "HP", "NOT"], 0), D("CUT", F.CUTOFF, 0, 127, 80), D("RES", F.PCT, 0, 127, 40), D("PW", F.PCT, 0, 127, 64)],
      presets: [P("FAT BASS", [0, 0, -12, 9, 0, 62, 45, 64], [0, 62, 60, 25], 1, 2), P("ARP LEAD", [2, 12, 0, 4, 0, 88, 25, 32], [0, 60, 90, 30], 0, 13),
        P("SYNC LEAD", [9, 9, 0, 0, 0, 82, 30, 64], [2, 70, 100, 40], 1, 4), P("RING BELL", [13, 0, 18, 6, 1, 96, 30, 64], [0, 92, 0, 80], 0, 7),
        P("CHIP CHOIR", [1, 0, 12, 7, 1, 62, 95, 40], [70, 90, 110, 85], 0, 5)] },
    { name: "WHEEL", titles: ["BARS", "TONE"], edit: [E("REG", ["FLUTE", "MELLO", "HOLLW", "SMOOT", "3BAR", "BLUES", "GOSPL", "ROCK",
        "TOPS", "CLARI", "REED", "STRNG", "CHAPL", "BRITE", "BASS", "FULL"], 4), D("SUB", F.INT, -8, 8, 0), D("BODY", F.INT, -8, 8, 0), D("TOP", F.INT, -8, 8, 0),
        E("PERC", ["OFF", "2ND", "3RD", "2SOFT", "3SOFT", "2SLOW", "3SLOW"], 0), D("CLICK", F.PCT, 0, 127, 40), D("DRV", F.PCT, 0, 127, 0), E("ROTR", ["OFF", "SLOW", "FAST"], 1)],
      presets: [P("FULL ORGAN", [15, 0, 0, 0, 0, 30, 20, 1], [0, 64, 127, 45], 0, 5), P("JAZZ PERC", [4, 0, 0, 0, 2, 50, 8, 1], [0, 64, 127, 40], 0, 3),
        P("GOSPEL", [6, 0, 0, 0, 1, 60, 40, 2], [0, 64, 127, 45], 0, 6), P("SOFT FLUTE", [1, 0, -2, 0, 0, 10, 0, 1], [0, 64, 127, 55], 0, 5),
        P("ROCK DRIVE", [7, 0, 0, 0, 0, 70, 100, 2], [0, 64, 127, 40], 0, 4)] },
    { name: "GRAIN", titles: ["GRAN", "SPRY"], edit: [E("SRC", ["PIANO", "PIANO", "FLUTE", "SAX", "PIANO", "USR1", "USR2", "USR3"], 0),
        D("POS", F.PCT, 0, 127, 32), D("SIZE", F.PCT, 0, 127, 80), D("DENS", F.PCT, 0, 127, 80),
        D("PTCH", F.SEMI, -24, 24, 0), D("SPRD", F.PCT, 0, 127, 30), D("RAND", F.PCT, 0, 127, 10), D("TONE", F.PCT, 0, 127, 127)],
      presets: [P("CLOUD PAD", [2, 50, 92, 88, 0, 40, 14, 100], [70, 90, 120, 90], 0, 5), P("GLITCH", [3, 64, 24, 112, 0, 100, 90, 127], [0, 70, 100, 30], 0, 4),
        P("FROZEN", [0, 40, 108, 72, 0, 0, 10, 92], [50, 100, 127, 100], 0, 5), P("SHIMMER", [0, 30, 70, 100, 12, 30, 24, 110], [30, 90, 110, 90], 0, 7)] },
    { name: "PHYS", titles: ["BODY", "EXCT"], edit: [E("MODEL", ["MODAL", "STRNG", "MEMB", "SYMP"], 0), D("STRC", F.PCT, 0, 127, 64),
        D("BRIT", F.PCT, 0, 127, 80), D("DAMP", F.PCT, 0, 127, 80), D("POS", F.PCT, 0, 127, 20), D("ACC", F.PCT, 0, 127, 90),
        D("BOW", F.PCT, 0, 127, 0), D("EXC", F.PCT, 0, 127, 0)],
      presets: [P("BELL TREE", [0, 70, 100, 106, 12, 100, 0, 6], [0, 100, 127, 96], 0, 7), P("MARIMBA", [0, 116, 38, 40, 24, 90, 0, 30], [0, 90, 127, 52], 0, 6),
        P("PLUCK", [1, 56, 72, 84, 40, 96, 0, 0], [0, 100, 127, 58], 0, 3), P("BOWED METAL", [0, 98, 70, 112, 10, 80, 90, 0], [60, 90, 127, 90], 0, 5),
        P("KALIMBA", [0, 34, 16, 56, 100, 90, 0, 48], [0, 100, 127, 60], 0, 7), P("HAND DRUM", [2, 112, 76, 56, 44, 100, 14, 24], [0, 100, 127, 64], 0, 6),
        P("TOMS", [2, 0, 52, 40, 30, 100, 40, 30], [0, 100, 127, 70], 0, 2), P("DRONE STRING", [3, 127, 80, 88, 64, 100, 92, 0], [0, 100, 127, 90], 0, 3),
        P("HARP", [3, 8, 62, 74, 60, 90, 0, 0], [0, 100, 127, 80], 0, 3)] },
    { name: "DRUM", titles: ["KIT", "HIT"], edit: [E("KIT", ["STD", "HAND", "CYM", "H+CYM", "80", "10", "66", "55", "77"], 0), D("TUNE", F.PCT, 0, 127, 64),
        D("TONE", F.PCT, 0, 127, 64), D("DECY", F.PCT, 0, 127, 64), D("SNAP", F.PCT, 0, 127, 64), D("ACC", F.PCT, 0, 127, 100),
        E("KICK", ["PUNCH", "ROUND"], 0), D("DRV", F.PCT, 0, 127, 0)],
      presets: [P("DRUM KIT", [0, 64, 70, 64, 64, 100, 0, 0], [0, 100, 127, 100], 0, 12)] },
    { name: "NOISE", titles: ["SRC", "MOVE"], edit: [E("MODE", ["ANLG", "DUST", "LFSR", "META"], 0), D("COLR", F.PCT, 0, 127, 64),
        D("FREQ", F.CUTOFF, 0, 127, 80), D("RES", F.PCT, 0, 127, 30), D("TRK", F.PCT, 0, 127, 64), D("DENS", F.PCT, 0, 127, 0),
        D("DRFT", F.PCT, 0, 127, 0), D("CRSH", F.PCT, 0, 127, 0)],
      presets: [P("WIND", [0, 64, 70, 100, 127, 0, 70, 0], [90, 90, 110, 90], 0, 5), P("RAIN", [1, 30, 88, 80, 64, 105, 40, 0], [10, 90, 127, 70], 0, 5),
        P("ARCADE", [2, 0, 127, 0, 127, 112, 0, 84], [0, 80, 0, 50], 0, 3), P("METAL", [3, 0, 100, 40, 100, 32, 0, 0], [0, 75, 40, 60], 0, 7)] },
    { name: "FM6", titles: ["OPS", "PATCH"], edit: [D("ALG", F.INT, 0, 32, 0), D("FB", F.INT, -7, 7, 0), D("MLVL", F.BIPCT, -64, 63, 0),
        D("MRAT", F.INT, -16, 16, 0), D("MEG", F.BIPCT, -64, 63, 0), D("VMOD", F.INT, -7, 7, 0), D("DTUN", F.PCT, 0, 127, 0),
        D("SLOT", F.INT, 0, FM6.FACTORY_PK.length, 0)],   /* F1..F8, then OWN (eng_fm6.c, 1.0.3) */
      presets: [P("TINE EP", [0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 127, 0], 0, 6), P("BELL", [0, 0, 0, 0, 0, 0, 0, 1], [0, 0, 127, 0], 0, 7),
        P("FM BASS", [0, 0, 0, 0, 0, 0, 0, 2], [0, 0, 127, 0], 1, 2), P("BRASS", [0, 0, 0, 0, 0, 0, 0, 3], [0, 0, 127, 0], 0, 4),
        P("PAD", [0, 0, 0, 0, 0, 0, 30, 4], [0, 0, 127, 0], 0, 5), P("MARIMBA", [0, 0, 0, 0, 0, 0, 0, 5], [0, 0, 127, 0], 0, 3),
        P("ORGAN", [0, 0, 0, 0, 0, 0, 0, 6], [0, 0, 127, 0], 0, 6), P("PLUCK", [0, 0, 0, 0, 0, 0, 0, 7], [0, 0, 127, 0], 0, 13)] },
    { name: "SLICE", titles: ["SLCE", "PLAY"], edit: [E("SRC", ["PIANO", "USR1", "USR2", "USR3"], 0),
        E("DIV", ["4", "8", "16", "32", "AUTO", "MAN"], 2), D("START", F.INT, 0, 31, 0), D("PTCH", F.SEMI, -24, 24, 0),
        E("MODE", ["ONE", "GATE", "LOOP"], 0), E("REV", ["OFF", "ON"], 0), D("DCAY", F.TIME, 0, 127, 127), D("TONE", F.INT, 0, 127, 127)],
      presets: [P("CHOP", [0, 2, 0, 0, 0, 0, 127, 127], [0, 127, 127, 30], 0, 9), P("STUTTER", [0, 1, 0, 0, 1, 0, 90, 110], [0, 127, 127, 12], 0, 10)] },
  ];
  const FM6_E = ENG.findIndex((e) => e.name === "FM6"), FM6_OWN = FM6.FACTORY_PK.length, DRUM_E = ENG.findIndex((e) => e.name === "DRUM");
  /* factory PATTERNS[] (engines.c; the device loads them from SEQ > PATTERNS, presets only suggest one): absolute
     notes, 0 rest; flags 1 accent, 2 slide, 4 tie (holds the previous note) */
  const T_ = 4;
  const PATTERNS = [
    [[45, 45, 57, 45, 0, 48, 45, 55, 45, 0, 57, 52, 45, 48, 0, 50], [1, 0, 2, 0, 0, 0, 1, 2, 0, 0, 1, 0, 0, 2, 0, 1]],
    [[0, 36, 0, 36, 0, 36, 0, 48, 0, 36, 0, 36, 0, 39, 0, 43], [0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]],
    [[60, 0, 67, 0, 72, 67, 0, 64, 62, 0, 69, 0, 74, 69, 0, 67], [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]],
    [[72, 0, 0, 74, 0, 0, 76, 0, 79, 0, 76, 0, 74, 0, 0, 0], [1, T_, 0, 2, T_, 0, 0, 0, 1, 0, 2, 0, 0, T_, T_, 0]],
    [[60, 0, 0, 0, 0, 0, 0, 0, 57, 0, 0, 0, 55, 0, 0, 0], [0, T_, T_, T_, T_, T_, T_, 0, 0, T_, T_, 0, 0, T_, T_, 0]],
    [[0, 0, 60, 0, 0, 63, 0, 0, 0, 0, 60, 0, 0, 65, 0, 63], [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]],
    [[72, 0, 0, 79, 0, 0, 84, 0, 0, 0, 76, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
    [[36, 0, 0, 0, 0, 0, 0, 36, 0, 0, 34, 0, 0, 0, 0, 0], [1, T_, T_, T_, 0, 0, 0, 0, 0, 0, 0, T_, T_, T_, 0, 0]],
    [[60, 61, 62, 67, 64, 65, 60, 69, 68, 70, 62, 67, 72, 72, 74, 64], [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]],
    [[60, 60, 61, 61, 62, 0, 63, 63, 64, 65, 65, 0, 66, 66, 66, 67], [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]],
    [[60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75], [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]],
    [[36, 42, 42, 42, 38, 42, 36, 42, 36, 42, 42, 36, 38, 42, 46, 42], [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]],   /* 12 BEAT (DRUM) */
    [[48, 51, 55, 60, 63, 67, 72, 75, 48, 51, 55, 60, 63, 67, 72, 75], [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]],   /* 13 ARP */
  ];
  for (let op = 0; op < 4; op++) TP.push(D("ATK", F.TIME, 0, 127, 0), D("DEC", F.TIME, 0, 127, 0), D("SUS", F.PCT, 0, 127, 127), D("REL", F.TIME, 0, 127, 0), D("LVL", F.PCT, 0, 127, 127));
  TP.push(E("CHRD", ["OFF", "DIA3", "DIA7", "MAJ", "MIN", "DOM7", "MAJ7", "MIN7", "SUS4", "POW"], 0),   /* the chord keys 81, 82 */
    E("VOIC", ["CLOSE", "OPEN", "INV1", "INV2", "+OCT"], 0));
  const P_COUNT = 91, G_COUNT = 27, NSTEP = 64, P_E0 = 83, G_ENGSEL = 20, P_SLCR = 45;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const enumOrig = (d, v) => d.fmt === F.ENUM && d.names ? aliasOf(d.names, v - d.min) + d.min : v;   /* params.c enum_orig */
  /* four tracks (firmware v3), four synth parts (1.0); engine / preset / p / step below are the selected track's */
  const NTRK = 4;
  const newTrack = () => ({ engine: 0, preset: 0, fm6: FM6.INIT_PK.slice(),
    p: TP.map((d) => d.def).concat(new Array(8).fill(0)),
    motion: {on: true, events: []},
    step: Array.from({ length: NSTEP }, () => ({ chance: 100, n: 0, notes: [0, 0, 0, 0], time: 2, flags: 0, vel: 0, hit: 0, acc: 0 })) });
  const st = {
    tracks: [0, 1, 2, 3].map(newTrack), sel: 0, rec: 0,
    g: GP.map((d) => d.def),
    slots: [null, null, null, null], songRows: [], chainPlaying: false, chainRow: 0, chainRemaining: 0,
    smp: [0, 1, 2].map(() => ({ flash: new Uint8Array(SMP.SLOT_SIZE).fill(0xFF), zones: 0, name: "", len: 0, next: SMP.DATA_OFF })),
    bank: new Array(opt.slots || 32).fill(null),     /* user presets: {engine, name, p, pattern, grid, fm6 (FM6: its patch)} */
    uiCaps: opt.legacy || opt.v3 || opt.v5 ? 0 : opt.uiCaps ?? 9,
    palette: 0, font: 0, monitor: 0, filter: 0, bankSig: 0,
    palettes: ["GREY", "GREEN", "AMBER", "ICE", "VIOLET", "ROSE", "PAPER", "HI-CON", "NIGHT", "MONO"],
    favorites: Array.from({ length: ENG.length + 1 }, () => []),
    menu: MENU.map((m) => m.def),                   /* the MENU settings' values (COLOR: palette) */
    watch: false, v4: false, lastReq: 0,
  };
  for (const k of ["engine", "preset", "p", "step"]) {
    Object.defineProperty(st, k, { enumerable: false, get: () => st.tracks[st.sel][k], set: (v) => { st.tracks[st.sel][k] = v; } });
  }
  const watchMs = opt.watchMs || 3000;
  const desc = (scope, id) => (scope === 0 && id < P_COUNT ? (id >= P_E0 ? ENG[st.engine].edit[id - P_E0] : TP[id])
    : scope === 1 && id < G_COUNT ? GP[id] : null);
  const EMPTY = { n: 0, notes: [0, 0, 0, 0], time: 2, flags: 0, vel: 0, hit: 0, acc: 0 };
  const isDrum = () => ENG[st.engine].name === "DRUM";
  const clearSteps = () => st.step.forEach((s) => Object.assign(s, EMPTY, { notes: [0, 0, 0, 0] }));
  function toGrid(s) {                            /* eng_drum.c step_to_grid: a lane's own note becomes its hit */
    if (s.time !== 0) return;
    const keep = s.notes.slice(0, s.n).filter((n) => { const l = drumLane(n); if (n !== LANE_NOTE[l]) return true; s.hit |= 1 << l; return false; });
    s.notes = [...keep, 0, 0, 0, 0].slice(0, 4); s.n = keep.length;
    if (!s.n && s.flags & 1) { s.acc |= s.hit; s.flags &= ~1; }
  }
  function loadPat16(pat) {                       /* ui.c load_pat16 (into a DRUM track: its grid) */
    const ps = stepsFromPattern(pat);
    st.step.forEach((s, i) => { Object.assign(s, EMPTY, i < 16 ? ps[i] : { notes: [0, 0, 0, 0] }); if (isDrum()) toGrid(s); });
    st.p[29] = 16;
  }
  const loadPattern = (k) => loadPat16(PATTERNS[k][0].map((n, i) => [n, PATTERNS[k][1][i]]));
  function applyPreset(pi) {
    const e = ENG[st.engine];
    if (e.name === "SAMPLE" && pi === PERC_SET) { setEngine(DRUM_E); return; }   /* once PERC: DRUM's kit (ui.c apply_preset_to) */
    pi = aliasOf(e.presets.map((x) => x.name), pi % e.presets.length);
    const pr = e.presets[pi];
    st.preset = pi;
    for (let i = 0; i < 8; i++) st.p[P_E0 + i] = pr.e[i];
    [1, 2, 3, 4].forEach((id, k) => { st.p[id] = pr.env[k]; });
    st.p[37] = pr.mono ? 2 : 0;
    st.p[33] = 0; st.p[34] = 24; st.p[35] = 28; st.p[36] = 36;
    for (let i = P_SLCR + 4; i < P_E0; i++) if (!trackOwn(i, P_E0)) st.p[i] = TP[i].def;   /* a factory preset turns the
                                                     matrix off; the SLICER, the chord keys, the steps and the other track
                                                     settings stay (ui.c apply_preset_to) */
    if (st.engine === FM6_E) {                    /* eng_fm6.c fm6_track_loaded */
      const t = st.tracks[st.sel];
      t.own = null;
      if (st.p[P_E0 + 7] < FM6_OWN) { t.fm6 = FM6.FACTORY_PK[st.p[P_E0 + 7]].slice(); t.slot = st.p[P_E0 + 7]; } else fm6Adopt(t);
    }
  }
  /* SLOT s turned (eng_fm6.c fm6_poll): F1..F8 that factory patch (from OWN the own patch kept aside), OWN the own
     patch back */
  function fm6Slot(t, s) {
    if (s === t.slot) return;
    if (s >= FM6_OWN) { if (t.own) t.fm6 = t.own; t.own = null; t.slot = FM6_OWN; return; }
    if (t.slot === FM6_OWN && !t.own) t.own = t.fm6.slice();
    t.fm6 = FM6.FACTORY_PK[s].slice(); t.slot = s;
  }
  /* t's patch was put in as its own (eng_fm6.c fm6_adopt): SLOT = the factory patch it equals, else OWN */
  function fm6Adopt(t) {
    t.own = null;
    if (t.engine !== FM6_E) return;
    const k = FM6.FACTORY_PK.findIndex((pk) => pk.every((x, i) => x === t.fm6[i]));
    t.p[P_E0 + 7] = t.slot = k < 0 ? FM6_OWN : k;
  }
  function setEngine(ei) {
    if (ei % ENG.length === 1) { fm4Load(0); return; }   /* DIGITAL (retired): its first preset, as FM6 (ui.c set_engine_of) */
    st.engine = ei % ENG.length;
    for (let i = 0; i < 8; i++) st.p[P_E0 + i] = ENG[st.engine].edit[i].def;
    applyPreset(0);
  }
  /* the selected track's sound = p, DIGITAL's values, converted (ui.c fm4_apply) */
  function fm4Apply(p) {
    const r = FM4.convert(p, P_E0);
    st.engine = FM6_E; st.preset = r.preset; st.p = r.p;
    st.tracks[st.sel].fm6 = FM6.pack(r.voice);
    fm6Adopt(st.tracks[st.sel]);                  /* (the converted patch is the track's own: SLOT OWN) */
  }
  function fm4Load(k) {                           /* a DIGITAL preset number (ui.c fm4_load_preset) */
    const p = st.p.map((x, i) => (i < P_E0 && !trackOwn(i, P_E0) ? TP[i].def : x));
    fm4Apply(FM4.presetValues(p, k, P_E0));
  }
  const snapshot = (name) => {                   /* (upreset.c up_store: a DRUM track that strikes a lane: its grid; an FM6
                                                     track: its patch, up_fm6.c) */
    const grid = isDrum() ? gridFromSteps(st.step) : null;
    const fm6 = st.engine === FM6_E ? st.tracks[st.sel].fm6.slice() : null;
    return patternUsed(grid) ? { engine: st.engine, name, p: st.p.slice(), pattern: null, grid, fm6 }
      : { engine: st.engine, name, p: st.p.slice(), pattern: patternFromSteps(st.step), grid: null, fm6 };
  };
  const stepOut = (x, b) => { b(x.n); x.notes.forEach(b); b(x.time); b(x.flags); b(x.vel); hitsEnc(x.hit, x.acc).forEach(b); if (!opt.legacy && !opt.v3 && !opt.v5) b(x.chance ?? 100); };
  function stepIn(x, a) {                         /* editor.c ed_step_put: n, 4 notes, time, flags, vel [, hits (3)] */
    x.n = Math.min(4, a[0]); x.notes = a.slice(1, 5); x.time = Math.min(2, a[5]); x.flags = a[6] & 3; x.vel = a[7];
    if (a.length >= 11) { x.hit = a[8] | (a[10] & 1) << 7; x.acc = (a[9] | (a[10] & 2) << 6) & x.hit; }
    if (a.length >= 12) x.chance = Math.min(100, a[11]);
  }
  /* a few user presets to start with, each with its preset's suggested pattern stored (as UP_STORE would) */
  [[0, 0, 0, "MY LEAD"], [1, FM6_E, 1, "GLASS BELL"], [2, 2, 3, "PHASE RESO"], [5, 3, 2, "8BIT ARP"]].forEach(([slot, e, p, name]) => {
    setEngine(e); applyPreset(p);
    if (ENG[e].presets[p].pat) loadPattern(ENG[e].presets[p].pat - 1);
    st.bank[slot] = snapshot(name);
    clearSteps(); st.p[29] = 16;
  });
  /* the power-on sounds (engines.c TRK_DEF): ACID, PAD, PULSE LD, DRUM KIT */
  [[1, FM6_E, 4], [2, 3, 0], [3, 10, 0], [0, 0, 4]].forEach(([i, e, p]) => { st.sel = i; setEngine(e); applyPreset(p); });
  /* the device powers on with its sequencers empty; the mock starts as a little demo to look at: track 1 with
     the ACID pattern, track 4 with BEAT (as SEQ > PATTERNS would load them), pads left, lead right */
  st.sel = 3; loadPattern(11);
  st.sel = 0; loadPattern(0);
  st.tracks[1].p[39] = -24; st.tracks[2].p[39] = 20; st.tracks[2].p[0] = 92;
  const project = () => JSON.parse(JSON.stringify({ tracks: st.tracks, sel: st.sel, g: st.g, songRows: st.songRows }));
  st.slots[0] = project();

  function handle(cmd, a) {
    const out = [];
    const b = (x) => out.push(x & 0x7F), v = (x) => out.push(...v14enc(x)), s = (x) => out.push(...strEnc(x));
    const u32 = (n) => { for (let i = 0; i < 5; i++) b((n >>> (i * 7)) & (i === 4 ? 15 : 127)); };
    if (opt.legacy && cmd >= CMD.UP_LIST) return null;
    if (opt.v3 && cmd >= CMD.TRACK_PARAM) return null;
    if (opt.v5 && cmd >= CMD.SONG) return null;
    if (!st.uiCaps && cmd >= CMD.UI_STATE) return null;
    const uiState = () => {
      const sig = JSON.stringify(st.favorites).split("").reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, st.filter);
      [st.uiCaps, st.palette, st.uiCaps & 2 ? st.font : 127, st.uiCaps & 4 ? st.monitor : 127, st.uiCaps & 8 ? st.filter : 127].forEach(b);
      for (const n of [sig, st.bankSig]) for (let i = 0; i < 4; i++) b(n >>> (i * 7));
    };
    const NB = st.bank.length;
    switch (cmd) {
      case CMD.UP_LIST: {
        if (a.length < 2) return null;
        const start = a[0], n = Math.max(0, Math.min(a[1], UP.LIST_MAX, NB - start));
        b(start); b(n); b(NB);
        for (let i = start; i < start + n; i++) { const u = st.bank[i]; b(u ? 1 : 0); b(u ? u.engine : 0); s(u ? u.name : ""); }
        break;
      }
      case CMD.UP_GET: {
        if (a.length < 1 || a[0] >= NB) return null;
        const u = st.bank[a[0]];
        b(a[0]); b(u ? 1 : 0); b(u ? u.engine : 0); s(u ? u.name : "");
        for (let i = 0; i < P_COUNT; i++) v(u ? u.p[i] : 0);
        if (u && u.grid) {                          /* kind 1: the grid's low 7 bits, then its bit 7s */
          for (let i = 0; i < UP.PAT; i++) { const x = hitsEnc(...u.grid[i]); b(x[0]); b(x[1]); }
          b(1);
          for (let i = 0; i < UP.PAT; i++) b(hitsEnc(...u.grid[i])[2]);
        } else {
          for (let i = 0; i < UP.PAT; i++) { const x = u ? u.pattern[i] : [0, 0]; b(x[0]); b(x[1]); }
          b(0);
        }
        break;
      }
      case CMD.UP_PUT: {
        if (a.length < 3) return null;
        const r = new Reader(a);
        let rc = 0;
        try {
          const slot = r.b(), engine = r.b(), name = r.s(), p = [], raw = [];
          let pattern = null, grid = null;
          for (let i = 0; i < P_COUNT; i++) p.push(r.v());
          for (let i = 0; i < UP.PAT; i++) raw.push([r.b(), r.b()]);
          const tail = a.length - r.i;
          if (tail !== 0 && (tail !== 1 + UP.PAT || a[r.i] > 1)) throw new Error("bad preset extension");
          if (tail && a[r.i] === 1) {              /* kind 1: a complete drum grid */
            r.b();
            grid = raw.map(([h, c]) => { const x = r.b(), hit = h | (x & 1) << 7; return [hit, (c | (x & 2) << 6) & hit]; });
          } else pattern = raw.map(([n, f]) => patNorm(n, f));
          if (slot >= NB || engine >= ENG.length || !name.length || name.length > UP.NAME_MAX || /[^\x20-\x7E]/.test(name)) rc = 1;
          else {
            const saved = st.engine;                /* values clamped to the ranges of that engine */
            const pc = fromPerc({ engine, p }, ENG.map((x) => x.name), P_E0);   /* SAMPLE PERC: DRUM (upreset.c up_migrate) */
            st.engine = pc ? pc.engine : engine;
            st.bank[slot] = { engine: st.engine, name, p: (pc ? pc.p : p).map((x, i) => { const d = desc(0, i); return clamp(x, d.min, d.max); }), pattern, grid };
            st.engine = saved;
          }
        } catch (e) { rc = 1; }
        b(a[0]); b(rc);
        break;
      }
      case CMD.UP_STORE: {
        if (a.length < 2) return null;
        const name = new Reader(a.slice(1)).s();
        const rc = a[0] >= NB || name.length > UP.NAME_MAX ? 1 : 0;
        if (!rc) st.bank[a[0]] = snapshot(name || `${ENG[st.engine].name} ${String(a[0] + 1).padStart(2, "0")}`);   /* (FM6: its patch) */
        b(a[0]); b(rc);
        break;
      }
      case CMD.UP_LOAD: {
        if (a.length < 1) return null;
        const u = st.bank[a[0]];
        if (u) {                                    /* the sound only (upreset.c up_load): the steps and the track's own */
          const own = st.p.slice();                 /* parameters (TRACK_OWN: mix, ARP, SCL, LEN.., SLICER) stay */
          const p = u.p.map((x, i) => (trackOwn(i, P_E0) ? own[i] : x));
          if (u.engine === 1) fm4Apply(p);          /* a DIGITAL record (kept as it is): FM6 */
          else { st.engine = u.engine; st.preset = 0; st.p = p; }
          if (u.engine === FM6_E) {                 /* its own patch (up_fm6.c upf_track_load); none: SLOT's factory / init */
            const t = st.tracks[st.sel], s = p[P_E0 + 7];
            t.fm6 = (u.fm6 || (s < FM6_OWN ? FM6.FACTORY_PK[s] : FM6.INIT_PK)).slice();
            fm6Adopt(t);
          }
        }
        b(a[0]); b(u ? 0 : 1);
        break;
      }
      case CMD.UP_ERASE:
        if (a.length < 1) return null;
        if (a[0] < NB) { st.bank[a[0]] = null; st.favorites[ENG.length][a[0]] = false; }
        b(a[0]); b(a[0] < NB ? 0 : 1);
        break;
      case CMD.WATCH:
        if (a.length < 1) return null;
        st.watch = !!(a[0] & 1);
        st.v4 = st.watch && !opt.v3 && !!(a[0] & 2);   /* v4: TRACK_CHANGED pushes too */
        b((st.watch ? 1 : 0) | (st.v4 ? 2 : 0));
        break;
      case CMD.PING:
        b(0);
        break;
      case CMD.UI_STATE: uiState(); break;
      case CMD.UI_PALETTES: b(st.palettes.length); st.palettes.forEach(s); break;
      case CMD.UI_SET: {
        const id = a[0], val = a[1], key = ["palette", "font", "monitor", "filter"][id];
        const rc = a.length !== 2 || !key ? 1 : !(st.uiCaps & 1 << id) ? 2 : val >= (id === 0 ? st.palettes.length : id === 2 ? 3 : 2) ? 1 : 0;
        if (!rc) st[key] = val;
        b(rc || (opt.noFlash ? 3 : opt.deferSettings ? 4 : 0)); b(id ?? 127); b(val ?? 127); uiState(); break;
      }
      case CMD.MENU_DESC: {
        if (opt.noMenu || opt.noFm6 || !syncCaps() || a.length !== 1) return null;
        const i = a[0], m = MENU[i], names = m && (m.names || st.palettes);
        b(i);
        if (!m) { b(127); break; }
        b(m.id); b(0); v(m.id === 0 ? st.palette : st.menu[i]); v(0); v(names.length - 1); s(m.name); names.forEach(s);
        break;
      }
      case CMD.MENU_SET: {
        if (opt.noMenu || opt.noFm6 || !syncCaps() || a.length !== 3) return null;
        const i = MENU.findIndex((m) => m.id === a[0]), m = MENU[i], val = v14dec(a[1], a[2]);
        if (!m) { b(1); b(a[0]); v(val); break; }
        const x = Math.max(0, Math.min((m.names || st.palettes).length - 1, val));
        if (m.id === 0) st.palette = x; else st.menu[i] = x;
        b(opt.noFlash ? 3 : opt.deferSettings ? 4 : 0); b(m.id); v(x);
        break;
      }
      case CMD.FAV_GET: case CMD.FAV_SET: {
        if (!(st.uiCaps & 8)) { b(2); break; }
        const engine = a[0], preset = v14dec(a[1], a[2]), count = a[3];
        const limit = engine === ENG.length ? st.bank.length : engine < ENG.length ? ENG[engine].presets.length : 0;
        if (a.length !== 4 || preset < 0 || preset >= limit ||
            (cmd === CMD.FAV_GET ? !count || count > 32 || preset + count > limit : count > 1 || engine === ENG.length && count && !st.bank[preset])) { b(1); break; }
        if (cmd === CMD.FAV_SET) st.favorites[engine][preset] = !!count;
        b(cmd === CMD.FAV_SET ? (opt.noFlash ? 3 : opt.deferSettings ? 4 : 0) : 0); b(engine); v(preset); b(count);
        if (cmd === CMD.FAV_GET) for (let i = 0; i < count; i++) b(!!st.favorites[engine][preset + i]);
        break;
      }
      case CMD.MOTION: {
        const track = st.tracks[a[0]], m = track && track.motion;
        if (!m) return null;
        let rc = 0;
        if (a.length > 1 && st.chainPlaying) rc = 3;
        else if (a[1] === 1) m.on = !!a[2];
        else if (a[1] === 2) m.events = [];
        else if (a[1] === 3 || a[1] === 4) {
          /* src/motion.c motion_param / motion_set_event: a step < 64, a parameter that can be recorded, its range */
          const id = a[3], rec = id < P_COUNT && (id <= 16 || (id >= 33 && id <= 36) || id === 38 || id === 39 || id === 44
            || (id >= 61 && id <= 80) || id >= P_E0);
          const at = m.events.findIndex(e => e.step === a[2] && e.param === a[3]);
          if (a[2] >= NSTEP || !rec) rc = 1;
          else if (a[1] === 4) { if (at >= 0) m.events.splice(at, 1); }
          else {
            const val = v14dec(a[4], a[5]), d = id >= P_E0 ? ENG[track.engine].edit[id - P_E0] : TP[id];
            if (!d || val < Math.max(-64, d.min) || val > Math.min(127, d.max)) rc = 1;
            else if (at < 0 && st.tracks.reduce((n,t) => n + t.motion.events.length, 0) >= 64) rc = 2;
            else { const e = {step:a[2],param:a[3],value:val}; if (at >= 0) m.events[at] = e; else m.events.push(e); }
          }
        }
        [a[0],rc,+m.on,m.events.length,64].forEach(b);
        m.events.forEach(e => {b(e.step);b(e.param);v(e.value);});
        break;
      }
      case CMD.INFO:
        s(opt.legacy ? "FELUCCA 0.4 BETA (MOCK)" : "FELUCCA v1.0 (MOCK)"); b(ENG.length); b(P_COUNT); b(G_COUNT); b(NSTEP); b(P_E0);
        ENG.forEach((e) => s(e.name));
        if (!opt.legacy) b(NTRK);
        if (!opt.legacy && !opt.v3 && !opt.v5) {
          b(16);
          if (st.uiCaps) { b(0x55); b(1); b(st.uiCaps); b(0x4d); b(1); b(64); b(1); if (!opt.noBackup) { b(0x42); b(1); b(3); } if (!opt.noFm6) { b(0x46); b(1); b(FM6.FACTORY_PK.length); b(0); }
            if (syncCaps()) { b(0x53); b(1); b(syncCaps()); if (!opt.noFm6) { b(0x50); b(1); b(3); if (!opt.noMenu) { b(0x4E); b(1); b(MENU.length); } } } }   /* (FM6 v2: no bank, preset patches; MENU settings) */
        }
        break;
      case CMD.GET: case CMD.SET: {
        if (a.length < 2) return null;
        const d = desc(a[0], a[1]);
        if (!d) return null;
        const arr = a[0] ? st.g : st.p;
        if (cmd === CMD.SET && a.length >= 4) {
          if (a[0] === 1 && a[1] === G_ENGSEL) setEngine(clamp(v14dec(a[2], a[3]), 0, ENG.length - 1));
          else if (d.max > d.min) arr[a[1]] = enumOrig(d, clamp(v14dec(a[2], a[3]), d.min, d.max));
          if (!a[0] && a[1] === P_E0 + 7 && st.engine === FM6_E) fm6Slot(st.tracks[st.sel], arr[a[1]]);   /* PTCH (fm6_poll) */
        }
        b(a[0]); b(a[1]); v(arr[a[1]]);
        break;
      }
      case CMD.DUMP:
        b(st.engine); b(st.preset); st.p.forEach(v); st.g.forEach(v);
        break;
      case CMD.TRACK:
        if (a.length >= 1 && a[0] < NTRK) st.sel = a[0];
        b(st.sel); b(NTRK);
        st.tracks.forEach((t, i) => { b(t.engine); b(t.preset); v(t.p[0]); b(t.p[40] ? 1 : 0); b((st.rec >> i) & 1); });
        break;
      case CMD.TRACK_MIX: {
        if (a.length < 1 || a[0] >= NTRK) return null;
        const t = st.tracks[a[0]];
        if (a.length >= 4) {
          t.p[0] = clamp(v14dec(a[1], a[2]), 0, 127);
          t.p[40] = a[3] ? 1 : 0;
        }
        b(a[0]); v(t.p[0]); b(t.p[40] ? 1 : 0);
        break;
      }
      case CMD.TRACK_DUMP: {
        if (a.length < 1 || a[0] >= NTRK) return null;
        const t = st.tracks[a[0]];
        b(a[0]); b(t.engine); b(t.preset); t.p.forEach(v);
        break;
      }
      case CMD.TRACK_PARAM: {
        if (a.length < 2 || a[0] >= NTRK || a[1] >= P_COUNT) return null;
        const t = st.tracks[a[0]], d = a[1] >= P_E0 ? ENG[t.engine].edit[a[1] - P_E0] : TP[a[1]];
        if (a.length >= 4 && d.max > d.min) t.p[a[1]] = enumOrig(d, clamp(v14dec(a[2], a[3]), d.min, d.max));
        b(a[0]); b(a[1]); v(t.p[a[1]]);
        break;
      }
      case CMD.TRACK_STEP: {
        if (a.length < 2 || a[0] >= NTRK || a[1] >= NSTEP) return null;
        const x = st.tracks[a[0]].step[a[1]];
        if (a.length >= 10) stepIn(x, a.slice(2));
        b(a[0]); b(a[1]); stepOut(x, b);
        break;
      }
      case CMD.DESC: {
        if (a.length < 2) return null;
        const d = desc(a[0], a[1]);
        if (!d) return null;
        b(a[0]); b(a[1]); b(d.fmt); v(d.min); v(d.max); v(d.def); s(d.label); s(d.unit || "");
        if (d.fmt === F.ENUM && d.names) for (let i = 0; i <= d.max - d.min && i < 24; i++) s(d.names[i]);
        break;
      }
      case CMD.STEP_GET: case CMD.STEP_SET: {
        if (a.length < 1 || a[0] >= NSTEP) return null;
        const x = st.step[a[0]];
        if (cmd === CMD.STEP_SET && a.length >= 9) stepIn(x, a.slice(1));
        b(a[0]); stepOut(x, b);
        break;
      }
      case CMD.FM6_GET: case CMD.FM6_PUT: case CMD.FM6_LIST: case CMD.FM6_ERASE: {   /* editor_fm6.c */
        if (opt.noFm6 || !st.uiCaps) return null;
        const nf = FM6.FACTORY_PK.length, fm6User = (k) => k < NB && st.bank[k] && st.bank[k].engine === FM6_E;
        if (cmd === CMD.FM6_LIST) {                 /* the factory patches; no bank (1.0.3) */
          if (a.length) return null;
          b(nf); b(0);
          for (let i = 0; i < nf; i++) { b(1); s(FM6.name(FM6.unpack(FM6.FACTORY_PK[i]))); }
        } else if (cmd === CMD.FM6_ERASE) {
          b(a[0] ?? 127); b(a.length !== 1 ? 1 : 3);   /* (3: no bank) */
        } else if (cmd === CMD.FM6_GET) {
          let rc = a.length !== 2 || a[0] > 3 ? 1 : 0, pk = null;
          if (!rc) {
            if (a[0] === 0 && a[1] < NTRK) pk = st.tracks[a[1]].fm6;
            else if (a[0] === 1) rc = 3;
            else if (a[0] === 2 && a[1] < nf) pk = FM6.FACTORY_PK[a[1]];
            else if (a[0] === 3 && a[1] < NB) { pk = fm6User(a[1]) ? st.bank[a[1]].fm6 : null; rc = pk ? 0 : 2; }
            else rc = 1;
          }
          b(a[0] ?? 127); b(a[1] ?? 127); b(rc);
          if (!rc) pk.forEach(b);
        } else {
          let rc = a.length !== 2 + 128 ? 1 : 0;
          const pk = rc ? null : FM6.pack(FM6.unpack(a.slice(2)));   /* (every value into its range) */
          if (!rc && a[0] === 0 && a[1] < NTRK) { st.tracks[a[1]].fm6 = pk; fm6Adopt(st.tracks[a[1]]); }
          else if (!rc && a[0] === 1) rc = 3;
          else if (!rc && a[0] === 3 && fm6User(a[1])) st.bank[a[1]].fm6 = pk;
          else rc = 1;
          b(a[0] ?? 127); b(a[1] ?? 127); b(rc);
        }
        break;
      }
      case CMD.PRESET:
        if (a.length < 2 || a[0] >= ENG.length) return null;
        if (a[0] === 1) fm4Load(a[1]);              /* a DIGITAL preset: its sound, as FM6 */
        else {
          if (a[0] !== st.engine) setEngine(a[0]);
          applyPreset(a[1]);
        }
        b(st.engine); b(st.preset);
        break;
      case CMD.SONG: {
        if (!a.length || a[0] > 3) return null;
        let rc = 0;
        if (a[0] === 1) {
          const rows = Array.from({ length: a[1] || 0 }, (_, i) => ({ slot: a[2 + 2 * i], repeat: a[3 + 2 * i] }));
          if (a.length < 2 || a[1] > 16 || a.length !== 2 + 2 * a[1] || rows.some((r) => r.slot > 3 || r.repeat < 1 || r.repeat > 16)) rc = 1;
          else if (st.chainPlaying) rc = 2;
          else st.songRows = rows;
        } else if (a[0] === 2) {
          if (st.chainPlaying) rc = 2;
          else if (!st.songRows.length) rc = 1;
          else {
            const missing = st.songRows.find((r) => !st.slots[r.slot]);
            if (missing) rc = 3 + missing.slot;
            else { st.chainPlaying = true; st.chainRow = 0; st.chainRemaining = st.songRows[0].repeat; }
          }
        } else if (a[0] === 3) st.chainPlaying = false;
        b(a[0]); b(rc); b(st.songRows.length); b(st.chainPlaying ? 1 : 0); b(st.chainRow); b(st.chainRemaining);
        st.songRows.forEach((r) => { b(r.slot); b(r.repeat); });
        break;
      }
      case CMD.PROJECT: {
        if (a.length < 2) return null;
        const k = a[1] & 3;
        if (a[0] > 2) return null;
        if (a[0] === 1) { st.chainPlaying = false; st.slots[k] = project(); }
        else if (a[0] === 0 && st.slots[k]) {
          st.chainPlaying = false; Object.assign(st, JSON.parse(JSON.stringify(st.slots[k])));
          /* SAMPLE PERC tracks: DRUM's kit (project.c proj_perc). Removed factory presets keep their saved sound; only
             the display index is normalized. */
          st.tracks.forEach((t) => {
            const pc = fromPerc({ engine: t.engine, p: t.p }, ENG.map((x) => x.name), P_E0);
            if (pc) { t.engine = pc.engine; t.p = pc.p; t.preset = 0; }
            if (t.preset >= ENG[t.engine].presets.length) t.preset = 0;
          });
        }
        b(a[0]); b(k); b(st.slots[k] ? 1 : 0);
        break;
      }
      case CMD.NAMES:
        if (a.length < 1 || a[0] >= ENG.length) return null;
        b(a[0]); b(ENG[a[0]].presets.length); ENG[a[0]].presets.forEach((p) => s(p.name));
        ENG[a[0]].titles.forEach(s);
        break;
      /* user sample slots: the header is checked like the firmware's ed_smp_end() */
      case CMD.SMP_BEGIN: case CMD.SMP_ERASE: {
        if (a.length < 1 || a[0] >= 3) return null;
        const u = st.smp[a[0]];
        if (cmd === CMD.SMP_ERASE) u.flash.fill(0xFF); else u.flash.fill(0xFF, 0, 4096);
        u.zones = 0; u.name = ""; u.len = 0; u.next = SMP.DATA_OFF;
        b(a[0]); b(0);
        break;
      }
      case CMD.SMP_WRITE: {
        if (a.length < 5 || a[0] >= 3) return null;
        const u = st.smp[a[0]], off = a[1] | (a[2] << 7) | (a[3] << 14), dat = unpack7(a.slice(4));
        let rc = 0;
        if (off < SMP.DATA_OFF || (off & 0xFF) || !dat.length || off + dat.length > SMP.SLOT_SIZE || dat.length > 256) rc = 1;
        else {
          if (!(off & 0xFFF)) u.flash.fill(0xFF, off, off + 4096);
          u.flash.set(dat, off);
          u.next = off + dat.length;
        }
        b(a[0]); b(off); b(off >> 7); b(off >> 14); b(rc);
        break;
      }
      case CMD.SMP_END: {
        if (a.length < 2 || a[0] >= 3) return null;
        const u = st.smp[a[0]], hd = unpack7(a.slice(1)), dv = new DataView(hd.buffer);
        let rc = 0;
        if (hd.length < SMP.HDR_LEN || dv.getUint32(0, true) !== 0x504D5346 || dv.getUint16(4, true) !== 1) rc = 2;
        else if (!hd[6] || hd[6] > 16) rc = 5;
        else {
          const len = dv.getUint32(16, true);
          if (len > SMP.MAX_DATA) rc = 1;
          else if (crc32(u.flash.subarray(SMP.DATA_OFF, SMP.DATA_OFF + len)) !== dv.getUint32(20, true)) rc = 3;
          else {
            u.flash.set(hd, 0);
            u.zones = hd[6]; u.len = len;
            u.name = String.fromCharCode(...hd.slice(8, 16)).replace(/\0.*$/, "");
          }
        }
        b(a[0]); b(rc);
        break;
      }
      /* full backup (EDITOR_PROTOCOL.md v7): LIST takes a snapshot, GET reads it, PUT begin / data / commit / abort */
      case CMD.BACKUP_LIST: {
        if (opt.noBackup || !st.uiCaps) return null;
        bk.snap = new Map(BK_IDS.filter((id) => (id !== 8 && id !== 9) || !opt.noFm6).map((id) => [id, bkObject(id)]));
        bk.put = null;
        b(1); b(0); b(bk.snap.size);
        for (const [id, v] of bk.snap) { b(id); u32(v.length); u32(v.length ? crc32(v) : 0); }
        break;
      }
      case CMD.BACKUP_GET: {
        if (opt.noBackup || !st.uiCaps) return null;
        if (a.length !== 8) { b(127); break; }
        const id = a[0], off = bkR(a, 1), n = a[6] | a[7] << 7, v = bk.snap && bk.snap.get(id);
        const rc = !bk.snap ? 5 : !v || n < 1 || n > 256 || off + n > v.length ? 1 : 0;
        b(id); b(rc); u32(off); b(n & 127); b(n >> 7);
        if (!rc) pack7(v.subarray(off, off + n)).forEach(b);
        break;
      }
      case CMD.BACKUP_PUT: {
        if (opt.noBackup || !st.uiCaps) return null;
        if (!a.length) { b(127); break; }
        const op = a[0], id = a[1];
        let rc = 0;
        if (op === 0) {                                /* begin: id, size, crc */
          const size = bkR(a, 2), crc = bkR(a, 7);
          const ok = id <= 9 && (id < 8 || !opt.noFm6) && (id === 0 ? size === 3584 || size === 3388 : id === 1 ? size === BK_SETTINGS
            : id <= 5 ? [0, 3584, 3388].includes(size) : id <= 7 ? size <= 3840 : id === 8 ? size === 0 || size === 3472
            : size === 0 || size === 3728);   /* (8: an older archive's bank, moved into the user presets; 9: their patches) */
          if (!ok || a.length !== 12) rc = 1;
          else { bk.snap = null; bk.put = { id, size, crc, buf: new Uint8Array(size), next: 0 }; }
        } else if (op === 1) {                         /* data: id, offset, pack7 (at most 256, in order) */
          const off = bkR(a, 2), dat = unpack7(a.slice(7));
          if (!bk.put || bk.put.id !== id) rc = 5;
          else if (off !== bk.put.next || !dat.length || dat.length > 256 || off + dat.length > bk.put.size) rc = 1;
          else { bk.put.buf.set(dat, off); bk.put.next = off + dat.length; }
        } else if (op === 2) {                         /* commit: length and CRC, then it is the device's */
          if (!bk.put || bk.put.id !== id) rc = 5;
          else if (bk.put.next !== bk.put.size || (bk.put.size && crc32(bk.put.buf) !== bk.put.crc)) rc = 2;
          else {
            if (id !== 8) bk.objs.set(id, bk.put.buf);
            if (id >= 2 && id <= 5) st.slots[id - 2] = bk.put.size ? (st.slots[id - 2] || project()) : null;
            bk.put = null;
          }
        } else if (op === 3) { if (bk.put && bk.put.id === id) bk.put = null; }
        else rc = 1;
        b(op); b(id); b(rc);
        break;
      }
      case CMD.SMP_INFO:
        b(3); b(SMP.SLOT_SIZE / 1024);
        st.smp.forEach((u) => { b(u.zones); s(u.zones ? u.name : ""); b(u.zones ? Math.ceil(u.len / 1024) : 0); });
        break;
      default:
        return null;
    }
    if ([CMD.UP_PUT, CMD.UP_STORE, CMD.UP_ERASE].includes(cmd) && out[1] === 0) st.bankSig++;
    return frame(cmd, out);
  }

  /* the backup objects: 0 the music now playing, 1 the settings, 2..5 the projects, 6 / 7 the user banks, 8 the FM6 bank
     of 1.0..1.0.2 (listed empty since 1.0.3), 9 the user presets' FM6 patches (1.0.3), 32..34 the sample slots (header and
     data). Their bytes are the mock's own (a restore keeps what it was given) */
  const BK_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 32, 33, 34], BK_SETTINGS = 96;
  const bk = { snap: null, put: null, objs: new Map() };
  const fill = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 131 + seed * 17 + (i >> 3)) & 255);
  function bkObject(id) {
    if (id >= 32) { const u = st.smp[id - 32]; return u.zones ? u.flash.slice(0, SMP.DATA_OFF + u.len) : new Uint8Array(0); }
    const had = bk.objs.get(id);
    if (id === 0) return had || fill(3584, 1);
    if (id === 1) return had || fill(BK_SETTINGS, 2);
    if (id <= 5) return st.slots[id - 2] ? had && had.length ? had : fill(3584, id) : new Uint8Array(0);
    if (id <= 7) { const used = st.bank.some((x, k) => x && (id === 6 ? k < 16 : k >= 16)); return used ? had && had.length ? had : fill(1200, id) : new Uint8Array(0); }
    if (id === 8) return new Uint8Array(0);
    return had || (st.bank.some((x) => x && x.fm6) ? fill(3728, 9) : new Uint8Array(0));
  }
  const bkR = (x, o) => (x[o] | x[o + 1] << 7 | x[o + 2] << 14 | x[o + 3] << 21 | (x[o + 4] & 15) << 28) >>> 0;

  /* a WebMIDI-like access object: one input and one output named "Felucca" */
  const input = { id: "mock-in", name: "Felucca", type: "input", state: "connected", onmidimessage: null };
  let busy = false;
  const output = {
    id: "mock-out", name: "Felucca", type: "output", state: "connected",
    send(data) {
      const f = unframe(data);
      if (!f) { console.error("mock: refused a frame that is not F0 7D 46 4C ... F7", data); return; }
      if (busy) { console.warn("mock: frame dropped (device holds only one frame)", data); return; }
      busy = true;
      watching();                                   /* a lapsed WATCH ends before this request counts */
      st.lastReq = Date.now();
      const flash = [CMD.UP_PUT, CMD.UP_STORE, CMD.UP_ERASE].includes(f.cmd) && !opt.legacy;
      setTimeout(() => {
        busy = false;
        const r = handle(f.cmd, f.a);
        if (r && input.onmidimessage) input.onmidimessage({ data: Uint8Array.from(r) });
        const ra = r ? r.slice(5, -1) : [];
        if (r && ((!syncCaps() && ((f.cmd === CMD.SET && f.a[0] === 1 && f.a[1] === G_ENGSEL) || f.cmd === CMD.PRESET))
          || (f.cmd === CMD.PROJECT && f.a[0] === 0 && ra[2]) || (f.cmd === CMD.UP_LOAD && !ra[1]))) reloadPush();
      }, f.cmd === CMD.SMP_ERASE ? 900 : f.cmd === CMD.SMP_BEGIN ? 120 : flash ? 150 : f.cmd === CMD.SMP_WRITE ? 25 + Math.random() * 10 : 4 + Math.random() * 12);
    },
  };
  /* WATCH ends by itself watchMs after the last request */
  function watching() {
    if (st.watch && Date.now() - st.lastReq > watchMs) st.watch = false;
    return st.watch;
  }
  function push(cmd, args) {
    if (!watching()) return false;
    const fr = Uint8Array.from(frame(cmd, args));
    setTimeout(() => { if (input.onmidimessage) input.onmidimessage({ data: fr }); }, 0);
    return true;
  }
  /* INFO 53 01 caps (firmware after 1.0): no RELOAD echo of the editor's own PRESET / G_ENGSEL */
  const syncCaps = () => (!opt.legacy && !opt.v3 && !opt.v5 && !opt.noFm6 && !opt.noSync && st.uiCaps ? 3 : 0);
  const reloadPush = () => push(CMD.RELOAD, opt.legacy ? [st.engine, st.preset] : [st.engine, st.preset, st.sel]);
  /* things done on the device itself */
  const sim = {
    knob(id = [9, 33, 35, P_E0 + 4][Math.floor(Math.random() * 4)], dv = Math.random() < 0.5 ? -4 : 4) {
      const d = desc(0, id);
      st.p[id] = clamp(st.p[id] + dv, d.min, d.max);
      push(CMD.CHANGED, [0, id, ...v14enc(st.p[id])]);
      return { id, value: st.p[id] };
    },
    reload(pi = st.preset + 1) {
      applyPreset(pi);
      reloadPush();
      return { engine: st.engine, preset: st.preset };
    },
    track(i = (st.sel + 1) % NTRK) {                /* TRACKS page KNOB 1 */
      st.sel = i;
      reloadPush();
      return i;
    },
    /* TRACKS page KNOB 2: the selected track's level; pushes CHANGED */
    level(v) {
      st.p[0] = v = clamp(v, 0, 127);
      push(CMD.CHANGED, [0, 0, ...v14enc(v)]);
      return v;
    },
    mute(on = !st.p[40]) { st.p[40] = on ? 1 : 0; push(CMD.CHANGED, [0, 40, ...v14enc(st.p[40])]); return st.p[40]; },
    /* a parameter of track i changed on the device: CHANGED for the selected track, else TRACK_CHANGED (v4 watch) */
    param(i, id, val) {
      const t = st.tracks[i], d = id >= P_E0 ? ENG[t.engine].edit[id - P_E0] : TP[id];
      t.p[id] = clamp(val, d.min, d.max);
      if (i === st.sel) push(CMD.CHANGED, [0, id, ...v14enc(t.p[id])]);
      else if (st.v4) push(CMD.TRACK_CHANGED, [i, id, ...v14enc(t.p[id])]);
      return t.p[id];
    },
    /* REC on TRACKS: arm / disarm live recording of a track (no push: the editor reads TRACK) */
    arm(i = st.sel) { st.rec ^= 1 << i; return (st.rec >> i) & 1; },
    step(i = Math.floor(Math.random() * 16)) {
      const x = st.step[i];
      if (x.n) x.flags ^= 1;
      else Object.assign(x, { n: 1, notes: [60 + Math.floor(Math.random() * 12), 0, 0, 0], time: 0, flags: 0, vel: 96 });
      push(CMD.STEP_CHANGED, opt.legacy ? [i] : [i, st.sel]);
      return i;
    },
  };
  if (opt.auto !== false) st.rec = 1 << 2;          /* the browser mock: track 3 armed, to show it */
  const timers = opt.auto === false ? [] : [
    setInterval(() => sim.knob(), 3000),
    setInterval(() => sim.step(), 11000),
    setInterval(() => sim.reload(), 27000),
    setInterval(() => sim.param((st.sel + 1) % NTRK, 39, Math.round(Math.random() * 80) - 40), 13000),   /* pan of another track */
  ];
  return {
    state: st, sim,
    tables: { TP, GP, ENG, PATTERNS, P_COUNT, G_COUNT, NSTEP, P_E0, G_ENGSEL, P_SLCR, NTRK, MENU,
      FM6: { bank: 0, own: FM6_OWN, init: FM6.INIT_PK, factory: FM6.FACTORY_PK } },   /* test_web.mjs: == the firmware */
    stop: () => timers.forEach(clearInterval),
    access: { sysexEnabled: true, inputs: new Map([[input.id, input]]), outputs: new Map([[output.id, output]]), onstatechange: null },
  };
}
/* Optional preferences: old firmware is never probed with unknown commands. */
async function readDevicePreferences(rq, info, names, previous = null) {
  if (!info.uiCaps) return null;
  const state = parse[CMD.UI_STATE](await rq(req.uiState()));
  const palettes = previous ? previous.palettes : parse[CMD.UI_PALETTES](await rq(req.uiPalettes()));
  let favorites = previous ? previous.favorites : [], slots = previous ? previous.slots : null;
  if (state.caps & 8) {
    if (!previous || state.bankSig !== previous.state.bankSig) slots = await bank.list(rq);
    if (!previous || state.favoriteSig !== previous.state.favoriteSig || state.bankSig !== previous.state.bankSig) {
      favorites = [];
      for (let engine = 0; engine <= info.nengines; engine++) {
        const total = engine === info.nengines ? slots.total : (names[engine] || []).length;
        const flags = favorites[engine] = [];
        for (let start = 0; start < total; start += 32) {
          const count = Math.min(32, total - start);
          const r = parse[CMD.FAV_GET](await rq(req.favGet(engine, start, count)));
          if (r.rc || r.engine !== engine || r.start !== start || r.count !== count) throw new Error("Invalid favorites reply");
          flags.push(...r.values);
        }
      }
    }
  }
  return { state, palettes, favorites, slots };
}
/* an enum value or a preset named like an earlier one is an alias kept for stored numbers (SAMPLE / GRAIN 1,
   once TRANH: PIANO): the device loads the earlier one, the lists hide it. -> the first index with names[i] */
function aliasOf(names, i) { const k = names ? names.indexOf(names[i]) : -1; return k >= 0 && k < i ? k : i; }

/* #48: note divisions (1/4, 8T, 2BAR, ...) are listed by length, longest first, as the device's knobs step them
   (src/params.c enum_order); the values stay. Any other list: in value order. -> d's values in the order shown */
function divLength(n) {
  const m = /^(\d+)\/(\d+)$/.exec(n) || /^(\d+)(T|BAR)$/.exec(n);
  return !m ? null : m[2] === "BAR" ? +m[1] : m[2] === "T" ? 2 / 3 / +m[1] : +m[1] / +m[2];
}
function enumShown(d) {
  const vals = [];
  for (let v = d.min; v <= d.max; v++) vals.push(v);
  const len = d.fmt === F.ENUM && d.names ? d.names.map(divLength) : [null];
  return len.includes(null) ? vals : vals.sort((a, b) => len[b - d.min] - len[a - d.min] || a - b);
}

/* the order the device shows its engines in (src/engines.c ENGINE_ORDER): the lists here follow it, the protocol keeps
   the engine numbers. engineOrder(names): the indices of names in that order, "-" (a reserved number) left out; a name
   the list does not know (another firmware) follows in index order */
const ENGINE_ORDER = ["ANALOG", "FM6", "DIGITAL", "PHASE", "LOFI", "SAMPLE", "VOICE", "TRIO", "WHEEL", "GRAIN", "PHYS", "NOISE",
  "SLICE", "DRUM"];
function engineOrder(names) {
  const rank = (n) => { const k = ENGINE_ORDER.indexOf(n); return k < 0 ? ENGINE_ORDER.length : k; };
  return (names || []).map((n, i) => i).filter((i) => names[i] !== "-")
    .sort((a, b) => rank(names[a]) - rank(names[b]) || a - b);
}

function devicePresetRows(info, names, preferences) {
  if (!preferences || !(preferences.state.caps & 8)) return [];
  const rows = engineOrder(info.engines).filter((engine) => names[engine]).flatMap((engine) => names[engine]
    .map((name, preset) => ({ engine, preset, name, user: false })).filter((row) => aliasOf(names[engine], row.preset) === row.preset));
  for (const slot of preferences.slots.slots) if (slot.used)
    rows.push({ engine: info.nengines, preset: slot.slot, name: slot.name, user: true });
  return rows.map((row) => ({ ...row, favorite: !!(preferences.favorites[row.engine] || [])[row.preset] }))
    .filter((row) => !preferences.state.filter || row.favorite);
}

/*PROTO-END*/
export {
  HDR, CMD, PUSH, UP, F, v14enc, v14dec, strEnc, frame, unframe,
  LANES, LANE_NOTE, LANE_OF, LANE_ALIAS, drumLane, stepLanes, stepAccents, hitsText, parseHits, hitsEnc,
  readHits, Reader, parse, upName, req, replyMatches, Link, NOTE_NAMES, noteName, parseNote,
  parseNotes, fmtValue, SMP, pack7, unpack7, CRC_TABLE, crc32, IMA_STEP, IMA_IDX, imaEncode,
  parseWav, resample, pyRound, normalize, FADE, takeSample, zoomView, autoTrim, rootFromName, buildSlot,
  LIB, paramKeys, sameKeys, remapParams, tailParams, patNorm, patternFromSteps, stepsFromPattern, patternUsed, gridFromSteps,
  cleanPatch, libraryFile, readLibraryFile, FLASH_OPT, bank, capturePatch, TRACK_OWN, P_CHORD, trackOwn, auditionPatch,
  startWatch, mixer, FM6, FM4, fromDigital, reservedFm4, PERC_SET, fromPerc, engineLabel, makeMockDevice,
  readDevicePreferences, aliasOf, divLength, enumShown, ENGINE_ORDER, engineOrder, devicePresetRows, MENU, readDeviceMenu,
};
