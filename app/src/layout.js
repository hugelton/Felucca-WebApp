// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// Where each parameter goes (felucca/src/core.h ids; editor.html LAYOUT), used when the device's layout is a
// known one (device.js knownLayout); otherwise every parameter is listed in id order. And the icons by label.

import { P_CHORD, P_LANES } from "./proto.js";
import { BY_LABEL, BY_WAVE, MOD_DST, MOD_SRC, SPECIAL } from "./paramicons.js";

/* group: {t: title, place, pages: [[title, scope, ids]]} or {t, mod: first id} (the matrix, 4 rows of SRC DST AMT);
   engine: true = the engine's EDIT pages (page titles from NAMES) */
export const LAYOUT = (pe0, engine) => [
  { t: "ENV", place: "sound", viz: "env", pages: [["ENV", 0, [1, 2, 3, 4, ...(pe0 >= 103 ? [102] : [])]], ["ENV DEST", 0, [5, 6, 7, 8]]] },   /* (1.5: ESYNC) */
  { t: "LFO", place: "sound", viz: "lfo", pages: [["LFO", 0, [9, 10, 11, 12]], ["LFO DEST", 0, [13, 14, 15, 16]],
    ...(pe0 >= 96 ? [["LFO 2", 0, [91, 92, 93]]] : [])] },   /* 1.4: SYNC TRIG POL */
  { t: "EDIT", place: "sound", engine: true, pages: [["EDIT 1", 0, [pe0, pe0 + 1, pe0 + 2, pe0 + 3]], ["EDIT 2", 0, [pe0 + 4, pe0 + 5, pe0 + 6, pe0 + 7]],
    ...(pe0 >= 91 && engine === "DRUM" ? [["LANES", 0, P_LANES.slice(0, 4)], ["LANES 2", 0, P_LANES.slice(4)]] : []),   /* lane levels 83..90 (1.1) */
    ...(pe0 >= 103 && engine === "ANALOG" ? [["FILTER", 0, [101, pe0 + 4, pe0 + 5, pe0 + 7]]] : [])] },   /* 1.5: TYPE CUT RES KTR (EDIT > FILTER) */
  ...(pe0 >= 61 ? [{ t: "MOD", place: "sound", mod: 49 }] : []),
  ...(pe0 >= 81 && engine === "DIGITAL" ? [{ t: "OP ENV", place: "sound", pages: [   /* a FELUCCA_FM4=1 build only */
    ...[0, 1, 2, 3].map((k) => [`OP${k + 1}`, 0, [61 + 5 * k, 62 + 5 * k, 63 + 5 * k, 64 + 5 * k]]),
    ["OP LVL", 0, [65, 70, 75, 80]]] }] : []),
  { t: "VOICE", place: "sound", pages: [["LEVEL", 0, [0]], ["VOICE", 0, [37, 38, 41, 42]], ["VOICE 2", 0, [43, 44, 39, 40]],
    ...(pe0 >= 96 ? [["VOICE 3", 0, [95]]] : [])] },   /* 1.4: SPRD (the device's EDIT > VOICE 3) */
  { t: "FX", place: "sound", pages: [["FX", 0, [33, 34, 35, 36]], ["SLICER", 0, [45, 46, 47, 48]],
    ...(pe0 >= 103 ? [["INSERT", 0, [96, 97, 98, 99, 100]]] : []), ["DLY", 1, [4, 5, 6, 7]],   /* (1.5: the track's INSERT, TYPE A B C MIX) */ ["REVERB", 1, [24, 8, 9]], ["CHORUS", 1, [10, 11]]] },
  { t: "SCL", place: "sound", pages: [["SCL", 0, [25, 26, 27, 28]], ...(pe0 >= 83 ? [["CHORD", 0, P_CHORD]] : [])] },
  { t: "ARP", place: "sound", pages: [["ARP", 0, [17, 18, 19, 20]], ["ARP 2", 0, [21, 22, 23, 24]]] },
  { t: "PATTERN", place: "seq", pages: [["PATTERN", 0, [29, 30, 31, 32, ...(pe0 >= 96 ? [94] : [])]]] },   /* (1.4: QNTZ, the track's) */
  /* BPM SWG CLK TUNE; MIDI (port), ROUT (MIDI IN). 1.4: as the device shows them, HOME > CLOCK, MENU > AUDIO TUNE,
     MENU > MIDI > MIDI IN (G_MIDI, 12, nothing reads it there) */
  { t: "GLOBAL", place: "settings", pages: pe0 >= 96 ? [["CLOCK", 1, [0, 1, 2]], ["AUDIO", 1, [3]], ["MIDI", 1, [14]]]
    : [["GLOBAL", 1, [0, 1, 2, 3]], ["MIDI", 1, [12, 14]]] },
];
/* globals that are actions or placeholders on the device: not shown (a placeholder also has no range: visible()) */
export const G_SKIP = new Set(["SLOT", "NAME", "LOAD", "SAVE", "ENG", "SET", "CLRSQ", "INIT", "SYNC", "CPU"]);
/* the globals a layout places (settings shows them in its order, then every other one it does not skip) */
export const placedGlobals = (pe0) => new Set(LAYOUT(pe0).flatMap((g) => (g.pages || []).filter(([, s]) => s === 1).flatMap(([, , ids]) => ids)));
export const visible = (d) => !!d && d.max > d.min && d.label !== "-";

export const HEAD_IC = { ENV: "function_env_adsr_exp", LFO: "waveform_sine", MOD: "symbol_modular", EDIT: "ui_knob", VOICE: "symbol_keyboard",
  FX: "symbol_effector", SCL: "control_arow_scale", ARP: "control_arrow_loop", PATTERN: "symbol_grid", GLOBAL: "symbol_cog", "OP ENV": "function_env_adsr_lin" };

/* a parameter's icon, as the device's param_icon() (felucca/src/icons.c; the table: paramicons.js, gen_icons.py):
   WAVE / WAVE2 by the shape set, the MOD matrix by its value (engine(k): the engine's k-th parameter's desc and
   value, for a destination E1..E8), then the parameters whose label means something else there, then by label */
const same = (a, b) => !!a && a.length === b.length && b.every((x, i) => a[i] === x);
export function paramIcon(d, v, engine) {
  if (!d) return null;
  if (typeof d === "string") return BY_LABEL[d] || SPECIAL.ICON_GENERIC || null;
  const n = d.names || [];
  if (/^SRC\d$/.test(d.label) && v != null) return MOD_SRC[Math.max(0, Math.min(MOD_SRC.length - 1, v - d.min))];
  if (/^AMT\d$/.test(d.label)) return MOD_SRC[0];                                  /* (the mod icon) */
  if (/^DST\d$/.test(d.label) && v != null) {
    const k = v - d.min, m = /^E([1-8])$/.exec(n[k] || "");
    if (m) { const e = engine && engine(+m[1] - 1); return e ? paramIcon(e.desc, e.value) : MOD_SRC[0]; }
    if (n[k] === "DEPTH") return SPECIAL.ICON_LFO_WAVE;                         /* (1.4: the LFO's depth) */
    return MOD_DST[Math.max(0, Math.min(MOD_DST.length - 1, k))];
  }
  if ((d.label === "WAVE" || d.label === "WAVE2") && n.length && v != null && BY_WAVE[n[v - d.min]]) return BY_WAVE[n[v - d.min]];
  if (d.scope === 0 && d.id === 10) return SPECIAL.ICON_LFO_WAVE;                 /* the LFO's WAVE (also the oscillator's) */
  if (d.scope === 0 && (d.id === 18 || d.id === 47)) return SPECIAL.ICON_DIVISION; /* arp / SLICER RATE: a note division */
  if (same(n, ["LP", "BP", "HP", "NOT"])) return SPECIAL.ICON_CUTOFF;             /* TRIO's MODE: the filter type */
  if (same(n, ["ANLG", "DUST", "LFSR", "META"])) return SPECIAL.ICON_NOISE;       /* NOISE's MODE: the source */
  if (d.scope === 0 && d.label === "CLK") return SPECIAL.ICON_RATE;               /* NOISE's CLK: the register clock */
  if (same(n, ["4", "8", "16", "32", "AUTO", "MAN"])) return SPECIAL.ICON_SLICE;
  if (same(n, ["ONE", "GATE", "LOOP"])) return SPECIAL.ICON_GATE;
  if (d.label === "REV" && same(n, ["OFF", "ON"]) && d.scope === 0 && d.id >= 61) return SPECIAL.ICON_ORDER;
  return BY_LABEL[d.label] || SPECIAL.ICON_GENERIC || null;
}
