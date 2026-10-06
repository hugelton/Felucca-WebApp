// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// Node checks of the new web editor (felucca/web/app): its modules against the mock device, the one-file build
// (bundle.py), the colour tokens (gen_tokens.py), and the page's rules (no colour outside the tokens, every icon
// in the font, the licence files beside what ships). No browser, no hardware. Run from the repo root:
//   node felucca/web/test_app.mjs
// The protocol section itself is checked by test_web.mjs (FELUCCA_PROTO=app runs it against app/src/proto.js).

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import * as proto from "./app/src/proto.js";
import { Device } from "./app/src/device.js";

let failed = 0;
const ok = (cond, what) => { console.log(`${what.padEnd(64)} ${cond ? "ok" : "FAIL"}`); if (!cond) failed++; };
const HERE = new URL(".", import.meta.url).pathname;
const APP = join(HERE, "app");
const py = (...args) => execFileSync("python3", args, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 2000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await sleep(10); return cond(); };

/* ------------------------------------------------------------- device.js --- */
{
  const m = proto.makeMockDevice({ auto: false });
  const d = new Device(m.access);
  const seen = { progress: 0, loaded: 0, param: [], step: [], reload: 0, closed: null };
  d.on("progress", () => seen.progress++);
  d.on("loaded", () => seen.loaded++);
  d.on("param", (p) => seen.param.push(p));
  d.on("step", (k) => seen.step.push(k));
  d.on("reload", () => seen.reload++);
  d.on("closed", (r) => { seen.closed = r; });
  await d.open();
  ok(d.loaded && seen.loaded === 1 && d.info.pcount === 91 && d.pdesc.length === 91 && d.gdesc.length === d.info.gcount,
    "device: open reads INFO and every DESC");
  ok(seen.progress > d.info.pcount && d.names.length === d.info.nengines && d.steps.length === d.info.nstep,
    "device: NAMES for every engine, every step, progress reported");
  ok(d.watch === 3 && d.v4 && d.mix && d.mix.tracks.length === 4 && d.bank && d.bank.total === 32,
    "device: live sync (WATCH 3), the mixer and the user bank");
  const st = d.storage();
  ok(st.slotKiB === d.smp.slotKiB && st.samples.length === d.smp.nslots && st.presets[1] === 32 && st.projects[1] === 4
     && (!d.info.fm6 || (d.info.fm6.bank ? st.fm6 && st.fm6[1] === d.info.fm6.bank : st.fm6 === null)),
    "device: storage summary (samples KiB, slots used; no FM6 bank since 1.0.3)");
  /* an edit: the reply's value is kept, the device has it */
  const cut = d.pdesc.findIndex((x) => x && x.label === "RATE");
  const v = await d.setParam(0, cut, 77);
  ok(v === 77 && d.dump.p[cut] === 77 && m.state.p[cut] === 77, "device: setParam writes SET and keeps the reply");
  /* a knob turned on the device: CHANGED -> "param" */
  const kn = m.sim.knob(33, 4);                     /* (not 9: the RATE just set is the user's for 600 ms) */
  ok(await until(() => seen.param.some((p) => p.id === 33 && p.value === kn.value && p.remote)) && d.dump.p[33] === kn.value,
    "device: a CHANGED push updates the dump and tells the page");
  /* the user's value wins over a push for a moment */
  d.touchedAt.set("0:35", Date.now());
  const before = d.dump.p[35];
  m.sim.knob(35, 4);
  await sleep(80);
  ok(d.dump.p[35] === before, "device: a push does not overwrite what the user is moving");
  /* a step changed on the device: STEP_CHANGED -> STEP_GET -> "step" */
  m.sim.step(3);
  ok(await until(() => seen.step.includes(3)), "device: STEP_CHANGED reads the step again");
  /* another preset on the device: RELOAD -> the sound is read again */
  m.sim.reload();
  ok(await until(() => seen.reload > 0) && d.dump.preset === m.state.preset, "device: RELOAD reads the sound again");
  /* another track */
  const r0 = seen.reload;
  await d.selectTrack(2);
  ok(d.sel === 2 && m.state.sel === 2 && seen.reload > r0, "device: selectTrack selects on the device and reads it");
  d.close("test");
  ok(seen.closed === "test" && d.closed, "device: close");
  let threw = "";
  try { await d.rq(proto.req.ping()); } catch (e) { threw = e.message; }
  ok(threw === "closed", "device: a closed session refuses requests");
  m.stop && m.stop();
}
{
  /* firmware without pushes: no WATCH, the 400 ms poll follows the device */
  const m = proto.makeMockDevice({ auto: false, legacy: true });
  const d = new Device(m.access);
  const params = [];
  d.on("param", (p) => params.push(p));
  await d.open();
  ok(!d.watch && !d.bank, "device: firmware before v2 polls (no WATCH, no user bank)");
  m.state.p[9] = (m.state.p[9] + 5) % 120;
  ok(await until(() => params.some((p) => p.id === 9 && p.value === m.state.p[9]), 3000), "device: the poll finds a change made on the device");
  d.close();
  m.stop && m.stop();
}
{
  const m = proto.makeMockDevice({ auto: false });
  const port = [...m.access.inputs.values()][0];
  const saved = port.name;
  Object.defineProperty(port, "name", { value: "Other", configurable: true });
  let err = "";
  try { await new Device(m.access).open(); } catch (e) { err = e.message; }
  ok(err === "nodevice", "device: no Felucca port -> nodevice");
  Object.defineProperty(port, "name", { value: saved, configurable: true });
  m.stop && m.stop();
}


/* ---------------------------------------------------- SEQ: steps and motion --- */
{
  const { stepToggled, laneToggled, stepOn, MOTION_IDS } = await import("./app/src/seq.js");
  const E0 = { n: 0, notes: [0, 0, 0, 0], time: 2, flags: 0, vel: 0, hit: 0, acc: 0, chance: 100 };
  const steps = [{ ...E0, n: 1, notes: [64, 0, 0, 0], time: 0, vel: 80 }, { ...E0 }];
  const on = stepToggled(steps, 1);
  ok(stepOn(on) && on.n === 1 && on.notes[0] === 64 && on.vel === 96, "seq: a step turned on plays the note before it at 96");
  ok(stepToggled([{ ...E0 }], 0).notes[0] === 60, "seq: with no note before it, C4");
  ok(!stepOn(stepToggled(steps, 0)) && stepToggled(steps, 0).notes[0] === 64, "seq: turning off keeps the notes (REST)");
  let g = laneToggled(E0, 2, 0);
  ok(g.hit === 4 && g.time === 0 && g.vel === 96, "seq: a lane hit makes the step play");
  g = laneToggled(g, 2, 1);
  ok(g.acc === 4 && g.hit === 4, "seq: ACC mode accents the lane");
  g = laneToggled(g, 2, 0);
  ok(g.hit === 0 && g.acc === 0 && g.time === 2, "seq: the last hit off: no accent left, the step rests");
  ok(laneToggled(E0, 5, 1).hit === 32, "seq: an accent on an empty lane makes it hit");
  ok(MOTION_IDS.length === 17 + 7 + 20 + 8 && !MOTION_IDS.includes(81) && !MOTION_IDS.includes(82) && MOTION_IDS.includes(90),
    "seq: MOTION's parameters (0..16, 33..36, 38, 39, 44, 61..80, 83..90)");

  const m = proto.makeMockDevice({ auto: false });
  const d = new Device(m.access);
  await d.open();
  const seen = [];
  d.on("step", (k) => seen.push(k));
  const w = await d.writeStep(5, { ...E0, n: 3, notes: [60, 64, 67, 0], time: 0, flags: 1, vel: 100, chance: 50 });
  ok(w && w.n === 3 && w.notes.slice(0, 3).join() === "60,64,67" && w.chance === 50 && m.state.step[5].chance === 50 && seen.includes(5),
    "device: writeStep (a chord, chance) and the device has it");
  const h = await d.writeStep(6, laneToggled(d.steps[6], 0, 1));
  ok(h.hit & 1 && h.acc & 1, "device: a grid hit with its accent");
  const r1 = await d.motionOp(3, { step: 2, param: 9, value: 40 });
  ok(r1 === 0 && d.motion.count === 1 && d.motion.events[0].param === 9, "device: MOTION adds an event");
  const r2 = await d.motionOp(3, { step: 2, param: 81, value: 1 });
  ok(r2 === 1 && d.motion.count === 1, "device: MOTION refuses a parameter it cannot record (rc 1)");
  await d.motionOp(4, { step: 2, param: 9 });
  ok(d.motion.count === 0, "device: MOTION deletes the event");
  await d.motionOp(3, { step: 1, param: 9, value: 10 });
  await d.clearSequence();
  ok(d.steps.every((x) => !stepOn(x) && !x.n && !x.hit) && d.motion.count === 0, "device: clear sequence empties every step and the motion");
  d.close();
}


/* ------------------------------------------------------------------ MIX --- */
{
  const m = proto.makeMockDevice({ auto: false });
  const d = new Device(m.access);
  await d.open();
  const tracks = [];
  d.on("track", (k) => tracks.push(k));
  const t1 = m.state.tracks[1];
  ok(d.mix.tracks.every((x) => x.pan != null && x.rev != null) && d.mix.tracks[1].rev === t1.p[36], "mix: every strip has PAN and REV (TRACK_DUMP)");
  await d.setMix(1, 50, 1);
  ok(t1.p[0] === 50 && t1.p[40] === 1 && d.mix.tracks[1].level === 50 && d.mix.tracks[1].mute === 1, "mix: level and mute of another track (TRACK_MIX)");
  await d.setTrackParam(2, "pan", -20, true);
  await d.setTrackParam(2, "rev", 70, true);
  ok(m.state.tracks[2].p[39] === -20 && m.state.tracks[2].p[36] === 70 && m.state.sel === 0, "mix: PAN and REV of another track (TRACK_PARAM), the selection stays");
  await d.setMix(0, 90, 0);
  ok(d.dump.p[0] === 90 && m.state.p[0] === 90, "mix: the selected track's fader is its SOUND LEVEL too");
  await d.setParam(0, 39, 25);
  ok(d.mix.tracks[0].pan === 25 && tracks.includes(0), "mix: SOUND's PAN of the selected track moves its strip");
  m.sim.param(3, 39, -10);
  ok(await until(() => d.mix.tracks[3].pan === -10), "mix: TRACK_CHANGED from the device moves another strip");
  d.close();
}
{
  /* firmware before v4: no TRACK_PARAM; PAN of another track on release, that track selected for a moment */
  const m = proto.makeMockDevice({ auto: false, v3: true });
  const d = new Device(m.access);
  await d.open();
  ok(!d.v4, "mix: v3 firmware (WATCH 1, no TRACK_PARAM)");
  await d.setTrackParam(1, "pan", 10, false);
  ok(m.state.tracks[1].p[39] !== 10, "mix: v3, nothing is sent while dragging");
  await d.setTrackParam(1, "pan", 10, true);
  ok(m.state.tracks[1].p[39] === 10 && m.state.sel === 0 && d.sel === 0 && !d.panning, "mix: v3, on release: selected for a moment, then back");
  d.close();
}


/* -------------------------------------------------------------- LIBRARY --- */
{
  const { Library, memoryStore, slotName } = await import("./app/src/library.js");
  const m = proto.makeMockDevice({ auto: false });
  const d = new Device(m.access);
  await d.open();
  const store = memoryStore(), lib = new Library(store);
  await lib.init();
  ok(lib.persistent && lib.patches.length === 0, "library: an empty store");
  const base = d.dump.p.slice();
  const [a] = await lib.add([{ name: "BASS ONE", engine: 0, engineName: d.info.engines[0], p: base, tags: ["bass", "dark"] }]);
  await lib.add([{ name: "PAD", engine: 2, engineName: d.info.engines[2], p: base, tags: ["pad"] }]);
  ok(lib.patches.length === 2 && a.id && (await store.all()).length === 2, "library: add keeps the sounds in the store");
  ok(lib.view({ q: "dark" }).length === 1 && lib.view({ tag: "pad" })[0].name === "PAD" && lib.view({ sort: "name" })[0].name === "BASS ONE"
     && lib.view({ engine: d.info.engines[2] }).length === 1, "library: search (name, tag), tag and engine filters, sort");
  await lib.update(a, { name: "BASS 1" });
  const again = new Library(store); await again.init();
  ok(again.get(a.id).name === "BASS 1", "library: a rename is kept (read back from the store)");
  const [dup] = await lib.duplicate(a);
  ok(dup.name === "BASS 1 2" && dup.id !== a.id, "library: duplicate");
  await lib.remove(dup.id);
  ok(!lib.get(dup.id) && (await store.all()).length === 2, "library: delete");
  /* import: a bad file is reported and the others still read (the earlier editor stopped at the first) */
  const good = JSON.stringify(lib.file("library", [a], d));
  const r = await lib.importFiles([{ name: "bad.json", text: "{ nope" }, { name: "good.json", text: good }], d);
  ok(r.added === 1 && r.errors.length === 1 && r.errors[0][0] === "bad.json", "library: import reads every good file, reports the bad one");
  const bankFile = JSON.stringify(lib.file("bank", [a], d));
  await lib.importFiles([{ name: "bank.json", text: bankFile }], d);
  ok(lib.patches.at(-1).tags.includes("bank"), "library: a bank file's sounds are tagged bank");
  /* adopt: the device without DIGITAL turns a DIGITAL sound into FM6, a SAMPLE PERC sound into DRUM's kit */
  const keys = d.keys, engines = d.info.engines, pe0 = d.info.pe0;
  const pad = base.slice();
  const perc = base.slice(); perc[pe0] = 4;
  const st = memoryStore();
  await st.putMany([{ id: "x", name: "OLD PAD", engine: 1, engineName: "DIGITAL", p: pad, pattern: null, tags: ["x"], created: "a", modified: "a" },
    { id: "y", name: "OLD PERC", engine: 4, engineName: "SAMPLE", p: perc, pattern: null, tags: [], created: "a", modified: "a" }]);
  await st.setMeta("layout", { keys, engines: [...engines.slice(0, 1), "DIGITAL", ...engines.slice(2)], pe0 });
  const old = new Library(st); await old.init();
  const n = await old.adopt(d);
  const x = old.get("x"), y = old.get("y"), want = proto.fromDigital({ p: pad }, engines, pe0);
  ok(n === 2 && x.engineName === "FM6" && x.fm6.join() === want.fm6.join() && y.engineName === "DRUM", "library: adopt converts DIGITAL to FM6, SAMPLE PERC to DRUM's kit");
  ok((await old.adopt(d)) === 0, "library: adopted again: nothing to change");

  /* the device's user bank */
  const slot = d.bank.slots.findIndex((z) => !z.used);
  ok(await d.bankPut(slot, a) && d.bank.slots[slot].used && d.bank.slots[slot].name === "BASS 1", `device: a library sound into ${slotName(slot)} (UP_PUT)`);
  const back = await d.bankGet(slot);
  ok(back && back.name === "BASS 1" && back.p.length === d.info.pcount && back.tags.includes("device"), "device: a slot to the library (UP_GET)");
  ok(await d.bankStore(slot, "STORED"), "device: store the sound now playing (UP_STORE)");
  ok(d.bank.slots[slot].name === "STORED", "device: .. the slot is read again");
  ok(await d.bankLoad(slot), "device: load a slot (UP_LOAD)");
  ok(await d.bankErase(slot) && !d.bank.slots[slot].used, "device: erase a slot (UP_ERASE)");
  ok((await d.bankLoad(slot)) === false, "device: loading an empty slot says so");
  const all = await d.bankAll();
  ok(Array.isArray(all) && all.length === d.bank.slots.filter((z) => z.used).length, "device: every used slot for a bank file");
  const bad = await d.bankPut(slot, { ...a, engine: 99, engineName: "NOPE" });
  ok(bad === undefined && !d.bank.slots[slot].used, "device: a sound of an engine the device lacks is refused");
  /* audition and capture */
  const fm = { name: "TRY", engine: 2, engineName: engines[2], p: (() => { const q = base.slice(); q[pe0] = 5; return q; })(), tags: [] };
  ok(await d.audition(fm) && d.dump.engine === 2 && d.dump.p[pe0] === 5, "device: audition sets the engine and the values");
  const cap = await d.capture("CAPTURED");
  ok(cap && cap.name === "CAPTURED" && cap.engine === 2 && cap.p.length === d.info.pcount, "device: capture the sound now playing");
  const fac = await d.captureFactory(0, 1);
  ok(fac && fac.tags.includes("factory") && !fac.pattern && !fac.grid && fac.name === d.names[0][1], "device: a factory preset to the library");
  /* favourites */
  const rows = proto.devicePresetRows(d.info, d.names, d.preferences);
  const rc = await d.favorite(rows[0], true);
  ok(rc === 0 && proto.devicePresetRows(d.info, d.names, d.preferences)[0].favorite, "device: a favourite star (FAV_SET)");
  d.close();
}


/* -------------------------------------------------------------- SAMPLES --- */
{
  const { Draft, splitKeys, decodeAudio, cleanName, MAX_DATA } = await import("./app/src/samples.js");
  const wav = (sr, n, f = 440) => {                 /* a 16-bit mono WAV */
    const b = new ArrayBuffer(44 + n * 2), v = new DataView(b), w = (o, x) => { for (let i = 0; i < x.length; i++) v.setUint8(o + i, x.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / sr * 2 * Math.PI * f) * 20000), true);
    return b;
  };
  const raw = await decodeAudio(wav(44100, 22050));
  ok(Math.abs(raw.length - 11025) <= 1, "samples: a WAV decodes to mono at 22050 Hz");
  let threw = false;
  try { await decodeAudio(new ArrayBuffer(10)); } catch { threw = true; }
  ok(threw, "samples: not audio, no browser decoder: refused");
  ok(splitKeys([60, 48, 72]).map((k) => k.join("-")).join() === "55-66,0-54,67-127", "samples: keys split half-way between the roots");
  ok(cleanName("vox chop ä long") === "VOX CHOP", "samples: a name is upper case ASCII, 8 characters");
  const d = new Draft();
  const z = d.add("PAD_C3.wav", raw);
  ok(z.root === 48 && d.name === "PAD_C3" && z.a === 0 && z.b === raw.length, "samples: a file's root and name from its file name, untrimmed");
  d.add("REC 1", raw, { root: 60, trim: true });
  ok(d.zones.length === 2 && d.zones[1].root === 60, "samples: a recording, auto-trimmed, root C4");
  d.trim(0, 100, 50);
  ok(d.zones[0].a === 100 && d.zones[0].b === 100 + Math.round(22050 * 0.01) && d.zones[0].s.length === d.zones[0].b - 100, "samples: the ends stay 10 ms apart");
  d.trim(0, 0, raw.length);
  ok(d.bytes === d.zones.reduce((n, x) => n + ((x.s.length + 1) >> 1), 0) && !d.tooBig, "samples: the size of the draft");
  const built = d.build(), ref = proto.buildSlot(d.name, d.zones.map((x) => ({ s: x.s, root: x.root })));
  ok(built.hdr.join() === ref.hdr.join() && built.data.length === ref.data.length, "samples: the slot is buildSlot's (header, ADPCM)");
  const big = new Draft();
  const long = new Float64Array(MAX_DATA * 2 + 4000);
  for (let i = 0; i < long.length; i++) long[i] = Math.sin(i / 10);
  big.add("LONG", long);
  ok(big.tooBig, "samples: too long for the slot: tooBig");

  const m = proto.makeMockDevice({ auto: false });
  const dv = new Device(m.access);
  await dv.open();
  let progress = 0;
  ok(await dv.smpWrite(1, built, (n) => { progress = n; }), "device: a sample slot written (BEGIN, WRITE x n, END)");
  ok(progress === built.data.length && dv.smp.slots[1].zones === 2 && dv.smp.slots[1].name === d.name && dv.storage().samples[1].kib > 0,
    "device: .. progress to the end, SMP_INFO read again (the flash header too)");
  const bad = { hdr: built.hdr.slice(), data: built.data };
  bad.hdr[0] ^= 0x01;                                /* (not a slot header: its magic) */
  const errs = [];
  dv.on("error", (e) => errs.push(e));
  ok((await dv.smpWrite(2, bad)) === undefined && errs.some((e) => e.code === "smp" && e.what === "end"), "device: a slot the device refuses at END is reported");
  ok(await dv.smpErase(1) && dv.smp.slots[1].zones === 0, "device: a sample slot erased");
  dv.close();
}


/* -------------------------------------------------------------- PROJECT --- */
{
  const { bkU32, bkPack } = await import("./fm1backup.js");
  const m = proto.makeMockDevice({ auto: false });
  const d = new Device(m.access);
  await d.open();
  ok(d.backupCaps() === 3 && d.info.fm6 && d.info.fm6.bank === 0 && d.info.fm6.caps === 3 && d.info.syncCaps === 3,
    "project: INFO has the backup tag (42 01 03) before FM6's and the sync tag, as the firmware's");
  const empty = d.slotUsed.indexOf(0);
  const sv = await d.project(1, empty);
  ok(sv && sv.used === 1 && d.slotUsed[empty] === 1, "project: save into an empty slot (PROJECT op 1)");
  const ld = await d.project(0, empty);
  ok(ld && ld.used === 1, "project: load it (op 0), the sound read again");
  const r = await d.songOp(1, [{ slot: empty, repeat: 2 }]);
  ok(r && r.rows.length === 1 && r.rows[0].repeat === 2 && d.song === r, "project: the song chain's rows (SONG op 1); d.song is the reply");
  ok((await d.songOp(2)) && d.song.playing, "project: song PLAY");
  ok((await d.songOp(3)) && !d.song.playing, "project: song STOP");
  const errs = [];
  d.on("error", (e) => errs.push(e));
  const unused = d.slotUsed.indexOf(0);
  if (unused >= 0) {
    ok(await d.songOp(1, [{ slot: unused, repeat: 1 }]), "project: a row of an empty project can be set (src/editor.c: checked at start)");
    await d.songOp(2);
    ok(errs.some((e) => e.code === "song" && e.rc === 3 + unused) && !d.song.playing, "project: .. PLAY refuses it (rc 3 + the slot)");
  }
  /* the full backup: saved, restored, saved again: the same objects */
  const file = await d.backupSave();
  ok(file && file.format === "felucca-backup" && file.objects.length === 13 && file.objects[2 + empty].size === 3584, "project: a full backup (13 objects)");
  const archive = d.backupCheck(JSON.stringify(file));
  ok((await d.backupRestore(archive)) && d.loaded, "project: restored, everything read again");
  const again = await d.backupSave();
  ok(again.objects.map((o) => o.crc).join() === file.objects.map((o) => o.crc).join(), "project: the backup after a restore is the same");
  let bad = "";
  try { d.backupCheck(JSON.stringify({ ...file, objects: file.objects.slice(0, 5) })); } catch (e) { bad = e.message; }
  ok(!!bad, "project: an incomplete backup file is refused before any write");
  /* the mock's BACKUP_PUT: a commit whose data does not match its CRC is refused (rc 2); data out of order (rc 1) */
  const put = async (args) => (await d.rq([proto.CMD.BACKUP_PUT, args], { timeout: 1000, retries: 0 }))[2];
  const bytes = new Uint8Array(96).fill(7);
  ok((await put([0, 1, ...bkU32(96), ...bkU32(123)])) === 0 && (await put([1, 1, ...bkU32(0), ...bkPack(bytes)])) === 0
     && (await put([2, 1])) === 2, "project: the mock refuses a commit whose CRC is wrong (rc 2)");
  ok((await put([0, 1, ...bkU32(96), ...bkU32(0)])) === 0 && (await put([1, 1, ...bkU32(32), ...bkPack(bytes.subarray(0, 32))])) === 1,
    "project: .. and a piece out of order (rc 1)");
  await put([3, 1]);
  d.close();
}


/* ------------------------------------------------------------ make_site.py --- */
{
  const dir = mkdtempSync(join(tmpdir(), "felucca-site-"));
  /* a package as fm1pkg_make.py writes one, as far as make_site reads it: the identity (one marker byte after each of
     the first 20 blocks of 0x30, 0x7D = none) and the loader's marker */
  const pkgOf = (id, loader = true) => {
    const raw = new Uint8Array(20 * 0x30 + 64).fill(0x55);
    for (let i = 0; i < 20; i++) raw[i * 0x30 + 0x2F] = i < id.length ? (id.charCodeAt(i) + i + 1) & 0xFF : 0x7D;
    if (loader) raw.set(new TextEncoder().encode("FELUCCA-LOADER-1"), 20 * 0x30 + 8);
    return raw;
  };
  writeFileSync(join(dir, "ok.fwsc"), pkgOf("FM-1_903"));
  writeFileSync(join(dir, "stock.fwsc"), pkgOf("FM-1_015"));
  writeFileSync(join(dir, "vendor.fwsc"), pkgOf("FM-1_903", false));
  const fwlic = join(dir, "fw");
  mkdirSync(join(fwlic, "LICENSES"), { recursive: true });
  writeFileSync(join(fwlic, "LICENSE"), "GPL\n"); writeFileSync(join(fwlic, "LICENSING.md"), "# fw\n");
  writeFileSync(join(fwlic, "LICENSES", "Apache-2.0.txt"), "A\n"); writeFileSync(join(fwlic, "LICENSES", "MIT-X.txt"), "M\n");
  const site = (pkg, out, ...extra) => {
    try { execFileSync("python3", [join(HERE, "make_site.py"), join(dir, pkg), "1.0.3", join(dir, out), ...extra], { encoding: "utf8", env: { ...process.env, FELUCCA_LICENCES: "" } }); return ""; }
    catch (e) { return String(e.stderr || e.message); }
  };
  ok(site("ok.fwsc", "s1", "--licences", fwlic) === "", "site: make_site.py builds with the firmware's licences (--licences)");
  const s1 = join(dir, "s1"), inst = readFileSync(join(s1, "webapp/installer/index.html"), "utf8");
  ok(!inst.includes("/*LIB*/") && !inst.includes("/*META*/") && !inst.includes("/*TOKENS*/") && inst.includes('"product": "FM-1_903"')
     && inst.includes("../../firmware/felucca-1.0.3.fwsc") && inst.includes(readFileSync(join(APP, "tokens.css"), "utf8")),
    "site: the installer, its libraries, the package's metadata and the colour tokens inlined");
  ok(/url\("\.\.\/editor\/fonts\/InterTight-subset\.ttf"\)/.test(inst) && existsSync(join(s1, "webapp/editor/fonts/InterTight-subset.ttf")),
    "site: the installer's font is the editor's, beside it");
  const pkgHtml = readFileSync(join(HERE, "index_pkg.html"), "utf8");
  const ids = ["lang", "go", "stock-file", "stock-go", "stock-recovery", "bar", "status", "log"];
  ok(ids.every((id) => pkgHtml.includes(`id="${id}"`)) && !/#[0-9a-f]{3,6}\b/i.test(pkgHtml.slice(pkgHtml.indexOf("<style>"), pkgHtml.indexOf("</style>"))),
    "site: the installer keeps every element its script uses; no colour outside the tokens");
  ok(existsSync(join(s1, "firmware/felucca-1.0.3.fwsc")) && readFileSync(join(s1, "firmware/LICENSING.md"), "utf8") === "# fw\n"
     && readdirSync(join(s1, "firmware/LICENSES")).sort().join() === "Apache-2.0.txt,MIT-X.txt,index.html",
    "site: the package with the firmware's LICENSE, LICENSING.md, LICENSES/ (not the web app's)");
  const ed = readFileSync(join(s1, "webapp/editor/index.html"), "utf8");
  ok(!/<script[^>]+src=/.test(ed) && !/<link rel="stylesheet"/.test(ed) && ed.includes("felucca-editor") && ed.includes("async function captureBackup"),
    "site: webapp/editor is the new editor in one page (modules, stylesheets, the backup inlined)");
  ok(ed.includes('<meta name="felucca-release" content="1.0.3">'), "site: the editor knows the release it ships with (its update notice)");
  const fonts = ["FUKIAI-LICENSE.txt", "InterTight-subset.ttf", "OFL.txt", "fukiai.ttf"];
  ok(fonts.every((f) => existsSync(join(s1, "webapp/editor/fonts", f)) && !lstatSync(join(s1, "webapp/editor/fonts", f)).isSymbolicLink())
     && readFileSync(join(s1, "webapp/editor/fonts/fukiai.ttf")).length === readFileSync(join(HERE, "fukiai.ttf")).length,
    "site: .. its fonts and their licences in fonts/ (files, not links)");
  ok(["index.html", "fukiai.ttf", "FUKIAI-LICENSE.txt", "fm1backup.js"].every((f) => existsSync(join(s1, "webapp/editor-classic", f)))
     && readFileSync(join(s1, "webapp/editor-classic/index.html"), "utf8") === readFileSync(join(HERE, "editor.html"), "utf8")
     && /url=webapp\/installer\//.test(readFileSync(join(s1, "index.html"), "utf8")), "site: the classic editor beside it (its font, licence, backup), the redirect");
  const nolic = site("ok.fwsc", "s2", "--licences", join(dir, "nowhere"));
  ok(/no firmware licence files/.test(nolic) && !existsSync(join(dir, "s2")), "site: no licence files: refused before anything is written");
  ok(/not a Felucca package/.test(site("stock.fwsc", "s3", "--licences", fwlic)), "site: an official package (FM-1_015) is refused");
  ok(/no Felucca loader/.test(site("vendor.fwsc", "s4", "--licences", fwlic)), "site: a package without Felucca's loader is refused");
}


/* ------------------------------------------------------------------ 6-OP --- */
{
  const m = proto.makeMockDevice({ auto: false });
  const d = new Device(m.access);
  await d.open();
  const t = m.state.tracks.findIndex((x) => m.tables.ENG[x.engine].name === "FM6");
  ok(d.fm6Ok() && t >= 0, "6-OP: the device has FM6 (INFO 46), a track plays it");
  const pk = await d.fm6Read(t);
  ok(pk && pk.length === 128 && pk.join() === m.state.tracks[t].fm6.join(), "6-OP: a track's patch (FM6_GET target TRACK)");
  const f3 = await d.fm6Factory(2);
  ok(f3 && f3.join() === proto.FM6.FACTORY_PK[2].join(), "6-OP: a factory patch (FM6_GET target FACTORY)");
  const v = proto.FM6.unpack(f3);
  v[proto.FM6.VI.ALG] = 4; v[proto.FM6.at(1, "OL")] = 33;
  ok(await d.fm6Send(t, proto.FM6.pack(v)), "6-OP: a patch to a track (FM6_PUT target TRACK)");
  const back = proto.FM6.unpack(await d.fm6Read(t));
  ok(back[proto.FM6.VI.ALG] === 4 && back[proto.FM6.at(1, "OL")] === 33, "6-OP: .. the track holds it");
  const fails = [];
  d.on("error", (e) => fails.push(e));
  ok((await d.fm6Send(t, new Array(127).fill(0))) === false && fails.length === 1, "6-OP: a record that is not 128 bytes is refused");
  /* a .syx file round trip: the voice the page exports reads back as itself */
  const r = proto.FM6.parseSysex(Uint8Array.from(proto.FM6.singleSysex(back)));
  ok(r.voices.length === 1 && proto.FM6.pack(r.voices[0].v).join() === proto.FM6.pack(back).join(), "6-OP: an exported voice imports as itself");
  d.close();
}


/* ------------------------------------------------- features: the old editor's, all in the new --- */
{
  /* every feature of editor.html (its audit), with where the new editor has it: [id, what, file, the code that does it] */
  const F = [
    ["connect", "connect, read everything, reconnect when the port comes back", "main.js", ["function onPortState", "connect()", "await d.open()"]],
    ["mock", "?mock=1 (and &legacy=1): a simulated device", "main.js", ["makeMockDevice({ legacy"]],
    ["live", "live sync: pushes, PING, WATCH again after a gap", "device.js", ["onPush(f)", "keepAlive()", "req.ping()", "visible()"]],
    ["poll", "polling on firmware without pushes", "device.js", ["async poll()"]],
    ["track", "select a track", "device.js", ["selectTrack(k)"]],
    ["preset", "engine and preset, prev / next", "sound.js", ["dev.loadPreset(", "step(-1)", "step(1)"]],
    ["init", "init sound", "sound.js", ["dev.initSound()"]],
    ["params", "every parameter in the device's groups, unknown layouts in id order", "layout.js", ['t: "ENV"', 't: "LFO"', 't: "EDIT"', 't: "MOD"', 't: "VOICE"', 't: "FX"', 't: "SCL"', 't: "ARP"']],
    ["fm6", "6-operator patch: read, send, live, import / export SysEx, factory patches, init", "fm6.js", ["dev.fm6Read(", "dev.fm6Send(", "LIVE", "parseSysex(", "singleSysex(", "dev.fm6Factory(", "FM6.init()"]],
    ["pattern", "LEN DIV SWG GATE", "layout.js", ['t: "PATTERN", place: "seq"']],
    ["steps", "steps: notes (chords), time, accent, slide, velocity, chance", "seq.js", ["parseNotes(", "TIMES", '"ACC"', '"SLD"', '"VEL"', '"CHANCE"']],
    ["grid", "the drum grid: hits and accents", "seq.js", ["laneToggled(", '["HIT", "ACC"]']],
    ["steps-io", "reload the steps, clear the sequence", "seq.js", ["dev.reloadSteps()", "dev.clearSequence()"]],
    ["motion", "motion: play, clear, edit, remove (and add)", "seq.js", ["dev.motionOp(1", "dev.motionOp(2)", "dev.motionOp(3", "dev.motionOp(4"]],
    ["mixer", "level, mute, pan of every track (and REV)", "mix.js", ["dev.setMix(", 'setTrackParam(k, "pan"', 'setTrackParam(k, "rev"']],
    ["presets", "the device's presets: ALL / FAV, stars, load", "libview.js", ["devicePresetRows(", "dev.favorite(", "dev.changePreference(3"]],
    ["factory-lib", "a factory preset to the library", "libview.js", ["dev.captureFactory("]],
    ["library", "the library: search, engine / tag, sort, audition, rename, tags, duplicate, delete, export, import, export all, keep", "libview.js",
      ["lib.view(", "dev.audition(", 't("rename")', '"TAGS"', "lib.duplicate(", "lib.remove(", 'lib.file("patch"', "lib.importFiles(", 'lib.file("library"', "dev.capture("]],
    ["library-db", "the same IndexedDB as before (a library carries over)", "library.js", ['indexedStore(name = "felucca-editor")', 'createObjectStore("patches", { keyPath: "id" })']],
    ["bank", "the user bank: load, store, to library, erase, reload, export, put a library sound", "libview.js",
      ["dev.bankLoad(", "dev.bankStore(", "dev.bankGet(", "dev.bankErase(", "dev.bankRefresh()", "dev.bankAll()", "dev.bankPut("]],
    ["dnd", "drag between the library and the bank", "libview.js", ["text/x-felucca-lib", "text/x-felucca-slot"]],
    ["samples", "samples: files, drop, zones, roots, keys, trim, auto trim, preview, record, write, erase", "sampview.js",
      ["decodeAudio(", '"drop"', "d.setRoot(", "d.keys", "drafts[k].trim(", "d.autoTrim(", "play(z)", "getUserMedia(", "dev.smpWrite(", "dev.smpErase("]],
    ["projects", "projects A..D: load, save", "project.js", ["dev.project(0, k)", "dev.project(1, k)"]],
    ["song", "the song chain: rows, repeats, play / stop", "project.js", ["dev.songOp(1, rows)", "dev.songOp(play ? 3 : 2)"]],
    ["backup", "the full backup: save, restore", "project.js", ["dev.backupSave(", "dev.backupCheck(", "dev.backupRestore("]],
    ["globals", "BPM, swing, tune, MIDI IN", "settings.js", ["G_SKIP", "dev.setParam(1, id, v)"]],
    ["display", "the device's display: theme, font, MIDI monitor", "settings.js", ['t("theme")', 't("font")', 't("monitor")', "dev.changePreference(id"]],
    ["system", "what the device reported", "settings.js", ['t("firmware")', 't("userBank")']],
    ["lang", "English / Japanese", "settings.js", ["setLang("]],
    ["installer-link", "a link to the installer", "index.html", ['href="../installer/"']],
  ];
  const miss = F.filter(([, , f, parts]) => { const src = readFileSync(join(APP, f === "index.html" ? f : "src/" + f), "utf8"); return !parts.every((x) => src.includes(x)); });
  ok(F.length === 30 && !miss.length, `features: all ${F.length} of the old editor's are in the new one` + (miss.length ? " (missing: " + miss.map((x) => x[0]).join(", ") + ")" : ""));
}


/* ------------------------------------------------------------ settings --- */
{
  const { G_SKIP, placedGlobals, visible, LAYOUT } = await import("./app/src/layout.js");
  ok(!G_SKIP.has("CLK") && !G_SKIP.has("MIDI"), "settings: CLK (MIDI clock) and MIDI (port) are shown");
  /* every global the firmware has is on a page (SOUND's FX, settings), or an action / placeholder: from desc.json */
  const dj = process.env.FELUCCA_DESC || join(HERE, "../../build/host/desc.json");
  if (existsSync(dj)) {
    const GP = JSON.parse(readFileSync(dj, "utf8")).GP, pe0 = 83;
    const placed = placedGlobals(pe0), settingsIds = LAYOUT(pe0).find((g) => g.place === "settings").pages.flatMap(([, , l]) => l);
    /* settings shows its pages' globals, then every global no page places; so what is left out is G_SKIP and no-range ones */
    const left = GP.filter((d) => G_SKIP.has(d.label) || !visible(d)).map((d) => d.label);
    ok(GP[2].label === "CLK" && GP[12].label === "MIDI" && settingsIds.includes(2) && settingsIds.includes(12) && placed.has(2) && placed.has(12)
       && left.every((l) => ["SLOT", "NAME", "LOAD", "SAVE", "ENG", "SET", "CLRSQ", "INIT", "SYNC", "CPU", "-"].includes(l)),
      "settings: only the firmware's actions and placeholders are left out (desc.json)");
  } else console.log("settings: every firmware global shown (no FELUCCA_DESC)                skip");
}


/* ------------------------------------------------------------- versions --- */
{
  const { parseVersion, cmpVersion, advice } = await import("./app/src/version.js");
  ok(parseVersion("FELUCCA v1.0.3").join() === "1,0,3" && parseVersion("FELUCCA 0.9 BETA").join() === "0,9,0" && parseVersion("FELUCCA v1.0 (MOCK)").join() === "1,0,0"
     && parseVersion("nothing") === null, "versions: read from INFO's string");
  ok(cmpVersion("1.0.2", "1.0.3") === -1 && cmpVersion("1.0.10", "1.0.9") === 1 && cmpVersion("v1.0", "1.0.0") === 0, "versions: compared by number");
  ok(advice("FELUCCA 0.9 BETA", "1.0.3") === "classic" && advice("FELUCCA 0.4 BETA (MOCK)", "") === "classic", "versions: before 1.0 -> the classic editor (or an update)");
  ok(advice("FELUCCA v1.0.2", "1.0.3") === "update" && advice("FELUCCA v1.0.3", "1.0.3") === "" && advice("FELUCCA v1.0.4", "1.0.3") === ""
     && advice("FELUCCA v1.0.2", "") === "", "versions: older than the site's release -> update; no release (a local page): nothing");
}

/* ------------------------------------------------------------- bundle.py --- */
{
  const dir = mkdtempSync(join(tmpdir(), "felucca-bundle-"));
  /* the protocol module through the bundler == the module itself */
  py(join(HERE, "bundle.py"), "--js", join(APP, "src/proto.js"), join(dir, "p.js"));
  const E = vm.runInNewContext(readFileSync(join(dir, "p.js"), "utf8"), { setTimeout, clearTimeout, setInterval, clearInterval, console });
  ok(Object.keys(E).sort().join() === Object.keys(proto).sort().join(), "bundle: the bundled module exports what the module does");
  ok(E.frame(3, [0, 9, 0, 64]).join() === proto.frame(3, [0, 9, 0, 64]).join(), "bundle: the bundled code runs (frame)");
  /* a small graph: imports in dependency order, renames, one scope per module */
  mkdirSync(join(dir, "g"));
  writeFileSync(join(dir, "g/a.js"), 'export const A = 1;\nexport function twice(x) { return 2 * x; }\n');
  writeFileSync(join(dir, "g/b.js"), 'import { A, twice as tw } from "./a.js";\nconst B = tw(A) + 1;\nexport { B };\n');
  writeFileSync(join(dir, "g/main.js"), 'import { B } from "./b.js";\nimport { A } from "./a.js";\nconst T = {\n  import: 1,\n};\nexport const C = A + B + T.import - 1;\n');
  py(join(HERE, "bundle.py"), "--js", join(dir, "g/main.js"), join(dir, "g.js"));
  const G = vm.runInNewContext(readFileSync(join(dir, "g.js"), "utf8"), {});
  ok(G.C === 4 && Object.keys(G).join() === "C", "bundle: a graph in dependency order, renamed imports");
  /* what it refuses */
  const refuse = (src, what) => {
    writeFileSync(join(dir, "g/bad.js"), src);
    let err = "";
    try { py(join(HERE, "bundle.py"), "--js", join(dir, "g/bad.js"), join(dir, "bad.js")); } catch (e) { err = String(e.stderr || e.message); }
    ok(err.includes("bundle.py"), "bundle: refuses " + what);
  };
  refuse("export default 1;\n", "export default");
  refuse("export let x = 1;\n", "export let");
  refuse('import * as a from "./a.js";\n', "import *");
  refuse('const m = import("./a.js");\n', "dynamic import()");
  refuse('import { A,\n  twice } from "./a.js";\n', "an import over two lines");
  refuse('import { nope } from "./a.js";\n', "a name the module does not export");
  writeFileSync(join(dir, "g/c1.js"), 'import { Y } from "./c2.js";\nexport const X = 1;\n');
  writeFileSync(join(dir, "g/c2.js"), 'import { X } from "./c1.js";\nexport const Y = 2;\n');
  refuse('import { X } from "./c1.js";\n', "an import cycle");
}

/* ------------------------------------------------------------ gen_tokens --- */
/* the firmware's files the web app is made from, each overridable (the web app may move to its own repository) */
const PALETTES = process.env.FELUCCA_PALETTES || join(HERE, "../tools/gen_ui_palettes.py");
const INTERTIGHT = process.env.FELUCCA_INTERTIGHT || join(HERE, "../assets/fonts/InterTight[wght].ttf");
if (existsSync(PALETTES)) {
  ok((() => { try { py(join(HERE, "gen_tokens.py"), join(APP, "tokens.css"), "--check", "--palettes", PALETTES); return true; } catch { return false; } })(),
    "tokens: app/tokens.css is what gen_tokens.py writes (from gen_ui_palettes.py)");
  const css = readFileSync(join(APP, "tokens.css"), "utf8");
  const hexes = [...css.matchAll(/--[\w-]+: (#[0-9a-f]{6});/g)].map((x) => x[1]);
  ok(hexes.length >= 28 && hexes.every((h) => h.slice(1, 3) === h.slice(3, 5) && h.slice(3, 5) === h.slice(5, 7)),
    "tokens: GREY and LIGHT are grey (R = G = B) in every token");
  const report = py(join(HERE, "gen_tokens.py"), join(dir0(), "t.css"), "--report", "--palettes", PALETTES);
  ok(/GREY /.test(report) && /LIGHT /.test(report), "tokens: every web text pairing passes WCAG AA (the tool checks)");
} else console.log("tokens: from gen_ui_palettes.py (no FELUCCA_PALETTES)              skip");
if (existsSync(INTERTIGHT))
  ok((() => { try { execFileSync("python3", [join(HERE, "gen_fonts.py"), "--check", "--source", INTERTIGHT]); return true; } catch { return false; } })(),
    "fonts: app/fonts/InterTight-subset.ttf is what gen_fonts.py cuts");
else console.log("fonts: from InterTight[wght].ttf (no FELUCCA_INTERTIGHT)           skip");
const FIRMWARE = process.env.FELUCCA_FIRMWARE || join(HERE, "..");
if (existsSync(join(FIRMWARE, "src/icons.c")))
  ok((() => { try { execFileSync("python3", [join(HERE, "gen_icons.py"), join(APP, "src/paramicons.js"), "--check", "--firmware", FIRMWARE], { stdio: "pipe" }); return true; } catch { return false; } })(),
    "icons: app/src/paramicons.js is what gen_icons.py reads from the firmware's icons.c");
else console.log("icons: from the firmware's icons.c (no FELUCCA_FIRMWARE)           skip");
{
  /* a parameter's icon as the device draws it: by label, WAVE by the shape set, the labels that mean something else */
  const { paramIcon } = await import("./app/src/layout.js");
  const { BY_LABEL, BY_WAVE, SPECIAL } = await import("./app/src/paramicons.js");
  const D = (o) => ({ scope: 0, id: 70, fmt: 3, min: 0, max: 3, names: [], ...o });
  ok(paramIcon(D({ label: "ATK" })) === BY_LABEL.ATK && paramIcon("ATK") === BY_LABEL.ATK, "icons: a parameter by its label");
  ok(paramIcon(D({ label: "ZZZZ" })) === SPECIAL.ICON_GENERIC && !!SPECIAL.ICON_GENERIC, "icons: an unknown label gets the generic one");
  const wave = D({ label: "WAVE", names: ["SIN", "SAW", "SQR", "TRI"] });
  ok(paramIcon(wave, 1) === BY_WAVE.SAW && paramIcon(wave, 2) === BY_WAVE.SQR && BY_WAVE.SAW !== BY_WAVE.SQR, "icons: WAVE follows the shape set");
  ok(paramIcon(D({ label: "WAVE", id: 10, names: ["X"] }), 0) === SPECIAL.ICON_LFO_WAVE, "icons: the LFO's WAVE");
  ok(paramIcon(D({ label: "RATE", id: 18 })) === SPECIAL.ICON_DIVISION && paramIcon(D({ label: "RATE", id: 47 })) === SPECIAL.ICON_DIVISION
    && paramIcon(D({ label: "RATE", id: 9 })) === BY_LABEL.RATE, "icons: arp and SLICER RATE are a division, the LFO's a rate");
  ok(paramIcon(D({ label: "MODE", names: ["LP", "BP", "HP", "NOT"] })) === SPECIAL.ICON_CUTOFF
    && paramIcon(D({ label: "MODE", names: ["ANLG", "DUST", "LFSR", "META"] })) === SPECIAL.ICON_NOISE
    && paramIcon(D({ label: "CLK", fmt: 0, names: [] })) === SPECIAL.ICON_RATE && paramIcon(D({ label: "CLK", scope: 1 })) === BY_LABEL.CLK,
    "icons: TRIO's and NOISE's MODE, NOISE's CLK (not the global CLK)");
  const { MOD_SRC, MOD_DST } = await import("./app/src/paramicons.js");
  const dst = D({ label: "DST1", id: 50, max: 13, names: ["OFF", "PIT", "FLT", "SHP", "LVL", "PAN", "DRV", "CHO", "DLY", "REV", "RATE", "VIB", "E1", "E2"] });
  const cut = { desc: D({ label: "CUT", id: 61, fmt: 0, max: 127 }), value: 64 };
  ok(MOD_SRC.length === 9 && MOD_DST.length === 12 && paramIcon(D({ label: "SRC1", id: 49, max: 8 }), 1) === MOD_SRC[1]
    && paramIcon(dst, 2) === MOD_DST[2] && paramIcon(dst, 12, (k) => (k === 0 ? cut : null)) === BY_LABEL.CUT
    && paramIcon(D({ label: "AMT1", id: 51, fmt: 0 }), 10) === MOD_SRC[0],
    "icons: the MOD matrix by its value (a destination E1..E8: that engine parameter's own)");
}
{
  /* felucca/web stands alone: no link in app/ points outside it; the licences beside the fonts are files of their own */
  const links = [];
  const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isSymbolicLink()) links.push(p); else if (f.isDirectory()) walk(p); } };
  walk(APP);
  const out = links.filter((p) => !realpathSync(p).startsWith(realpathSync(HERE)));
  ok(!out.length, "web: no link in app/ leaves felucca/web" + (out.length ? " (" + out.map((p) => p.slice(HERE.length)).join(", ") + ")" : ""));
}
function dir0() { return mkdtempSync(join(tmpdir(), "felucca-tokens-")); }

/* ------------------------------------------------------------- the page --- */
{
  const files = readdirSync(join(APP, "src")).filter((f) => f.endsWith(".js")).map((f) => join(APP, "src", f));
  const page = existsSync(join(APP, "index.html")) ? join(APP, "index.html") : null;
  const sources = [...files, ...(page ? [page] : []), ...(existsSync(join(APP, "app.css")) ? [join(APP, "app.css")] : [])];
  const colours = sources.filter((f) => /#[0-9a-f]{3,6}\b|rgba?\(/i.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")) && !f.endsWith("proto.js"));
  ok(colours.length === 0, "page: no colour outside tokens.css" + (colours.length ? " (" + colours.map((f) => f.split("/").pop()).join(", ") + ")" : ""));
  ok(sources.every((f) => /SPDX-License-Identifier: GPL-3\.0-only/.test(readFileSync(f, "utf8")) && /Leo Kuroshita \(@kurogedelic\), Hügelton Instruments/.test(readFileSync(f, "utf8"))),
    "page: every source has the SPDX and copyright header");
  ok(existsSync(join(APP, "fonts/InterTight-subset.ttf")) && existsSync(join(HERE, "fukiai.ttf")), "page: the fonts are there");
}


/* ------------------------------------------------- the page: words, icons, build --- */
{
  const { TEXT } = await import("./app/src/text.js").catch(() => ({ TEXT: null }));
  const src = readdirSync(join(APP, "src")).filter((f) => f.endsWith(".js") && f !== "proto.js" && f !== "glyphs.js")
    .map((f) => readFileSync(join(APP, "src", f), "utf8")).join("\n") + readFileSync(join(APP, "index.html"), "utf8");
  ok(TEXT && Object.keys(TEXT.en).sort().join() === Object.keys(TEXT.ja).sort().join(), "page: English and Japanese have the same words");
  const used = new Set([...src.matchAll(/data-t="(\w+)"|"data-t": (\w+)\b|\bt\("(\w+)"\)|sayK\("(\w+)"/g)].map((m) => m[1] || m[3] || m[4]).filter(Boolean));
  const missing = [...used].filter((k) => !TEXT.en[k]);
  ok(!missing.length, "page: every word the page uses is in TEXT" + (missing.length ? " (" + missing.join(", ") + ")" : ""));
  ok((() => { try { py(join(HERE, "gen_glyphs.py"), join(APP, "src/glyphs.js"), "--check"); return true; } catch { return false; } })(),
    "icons: app/src/glyphs.js is what gen_glyphs.py reads from fukiai.ttf");
  const { GLYPH } = await import("./app/src/glyphs.js");
  const names = new Set([...src.matchAll(/"((?:waveform|function|symbol|control|port|ui|note|numbers|system)_[a-z0-9_]+)"/g)].map((m) => m[1]));
  const absent = [...names].filter((n) => !GLYPH[n]);
  ok(names.size > 20 && !absent.length, "icons: every glyph name the page uses is in the font" + (absent.length ? " (" + absent.join(", ") + ")" : ""));
  {
    /* icons(): a <span data-i> gets the icon face (class ic) and its glyph (once missing: the frame's icons drew nothing) */
    const { icons } = await import("./app/src/dom.js");
    const fake = { dataset: { i: "symbol_cog" }, cls: new Set(), attrs: {}, textContent: "",
      classList: { add(c) { fake.cls.add(c); } }, setAttribute(k, v) { fake.attrs[k] = v; } };
    icons({ querySelectorAll: () => [fake] });
    ok(fake.cls.has("ic") && fake.textContent === String.fromCodePoint(GLYPH.symbol_cog) && fake.attrs["aria-hidden"] === "true",
      "icons: a data-i span gets the icon face and its glyph");
  }
  {
    /* what ships publicly: no notes to self (memos, R numbers, dates, private paths) in the new sources */
    const own = [...readdirSync(join(APP, "src")).filter((f) => f.endsWith(".js") && f !== "glyphs.js").map((f) => join(APP, "src", f)),
      join(APP, "index.html"), join(APP, "app.css"), join(HERE, "bundle.py"), join(HERE, "gen_tokens.py"), join(HERE, "gen_glyphs.py"), join(HERE, "gen_fonts.py"), join(HERE, "gen_icons.py")];
    const bad = own.filter((f) => {
      const x = readFileSync(f, "utf8").replace(/"exported": "\d{4}-\d\d-\d\dT[^"]*"/g, "");   /* (a sample file's timestamp in the mock) */
      const notes = (x.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/g) || []).join("\n");   /* (R numbers: in comments; "R1" is an EG rate) */
      return /\bmemos\b|\b20\d\d-\d\d-\d\d\b|\/Users\/|fm-1-research|\bscratch\b/.test(x) || /\bR\d{1,2}\b/.test(notes);
    });
    ok(!bad.length, "page: no memos, R numbers, dates or private paths in what ships" + (bad.length ? " (" + bad.map((f) => f.split("/").pop()).join(", ") + ")" : ""));
  }
  {
    /* no makers' or instruments' names in what ships (labels, messages, comments, tests); the attributions the
       licences ask for (the installer's credits) and the FM-1 note are the exceptions */
    const files = [...readdirSync(HERE).filter((f) => /\.(html|js|mjs|py)$/.test(f) && f !== "test_app.mjs").map((f) => join(HERE, f)),   /* (this file: the list) */
      ...readdirSync(join(APP, "src")).filter((f) => f.endsWith(".js") && f !== "glyphs.js").map((f) => join(APP, "src", f)), join(APP, "index.html"), join(APP, "app.css")];
    const BRANDS = /\b(yamaha|roland|korg|moog|casio|kawai|nintendo|commodore|elektron|teenage engineering|op-1|dx-?7|dx7ii|tx-?81|game ?boy|tr-?808|tr-?909)\b/i;
    const hits = files.filter((f) => BRANDS.test(readFileSync(f, "utf8")));
    ok(!hits.length, "page: no makers' or instruments' names in what ships" + (hits.length ? " (" + hits.map((f) => f.split("/").pop()).join(", ") + ")" : ""));
  }
  {
    /* replaceChildren / append write null as the text "null": a child that may be null goes through put() (dom.js) or el() */
    /* each call's whole argument list, over lines (brackets balanced) */
    const calls = (src) => {
      const out = [], rx = /\.(replaceChildren|append)\(/g;
      let m;
      while ((m = rx.exec(src))) {
        let i = m.index + m[0].length, depth = 1;
        while (i < src.length && depth) { const c = src[i++]; if (c === "(") depth++; else if (c === ")") depth--; }
        out.push([src.slice(0, m.index).split("\n").length, src.slice(m.index + m[0].length, i - 1)]);
      }
      return out;
    };
    const bad = readdirSync(join(APP, "src")).filter((f) => f.endsWith(".js")).flatMap((f) =>
      calls(readFileSync(join(APP, "src", f), "utf8")).map(([n, args]) => [f, n, args])
        .filter(([, , args]) => {
          /* the top-level arguments only (a null inside el(...) is el's to drop) */
          const top = []; let depth = 0, cur = "";
          for (const c of args) { if ("([{".includes(c)) depth++; else if (")]}".includes(c)) depth--; if (c === "," && !depth) { top.push(cur); cur = ""; } else cur += c; }
          top.push(cur);
          return top.some((x) => /^\s*null\s*$|\?[^?]*:\s*null\s*$/.test(x));
        }));
    ok(!bad.length, "page: no possibly-null child given to replaceChildren / append" + (bad.length ? " (" + bad.map(([f, n]) => f + ":" + n).join(", ") + ")" : ""));
  }
  ok(!/\binnerHTML\b/.test(src), "page: no innerHTML (elements are built)");
  /* the one-file page: no module script left, the code compiles, the stylesheets inlined */
  const dir = mkdtempSync(join(tmpdir(), "felucca-page-"));
  py(join(HERE, "bundle.py"), join(APP, "index.html"), join(dir, "index.html"));
  const page = readFileSync(join(dir, "index.html"), "utf8");
  const js = page.slice(page.indexOf('<script type="module">') + 22, page.lastIndexOf("</script>"));
  let compiled = false;
  try { new vm.Script(js); compiled = true; } catch (e) { console.log(e.message); }
  ok(compiled && !/<script[^>]+src=/.test(page) && !/<link rel="stylesheet"/.test(page) && /--bg:/.test(page) && /\.gauge/.test(page),
    "build: index.html becomes one file (modules and stylesheets inlined, compiles)");
  ok(/url\("fonts\/InterTight-subset\.ttf"\)/.test(page) && /url\("fonts\/fukiai\.ttf"\)/.test(page) && /fonts\/OFL\.txt/.test(page) && /fonts\/FUKIAI-LICENSE\.txt/.test(page),
    "build: the fonts and their licences beside the page (fonts/)");
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
