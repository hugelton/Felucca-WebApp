// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// Where each parameter goes (felucca/src/core.h ids; editor.html LAYOUT), used when the device's layout is a
// known one (device.js knownLayout); otherwise every parameter is listed in id order. And the icons by label.

import { P_CHORD } from "./proto.js";

/* group: {t: title, place, pages: [[title, scope, ids]]} or {t, mod: first id} (the matrix, 4 rows of SRC DST AMT);
   engine: true = the engine's EDIT pages (page titles from NAMES) */
export const LAYOUT = (pe0, engine) => [
  { t: "ENV", place: "sound", viz: "env", pages: [["ENV", 0, [1, 2, 3, 4]], ["ENV DEST", 0, [5, 6, 7, 8]]] },
  { t: "LFO", place: "sound", viz: "lfo", pages: [["LFO", 0, [9, 10, 11, 12]], ["LFO DEST", 0, [13, 14, 15, 16]]] },
  { t: "EDIT", place: "sound", engine: true, pages: [["EDIT 1", 0, [pe0, pe0 + 1, pe0 + 2, pe0 + 3]], ["EDIT 2", 0, [pe0 + 4, pe0 + 5, pe0 + 6, pe0 + 7]]] },
  ...(pe0 >= 61 ? [{ t: "MOD", place: "sound", mod: 49 }] : []),
  ...(pe0 >= 81 && engine === "DIGITAL" ? [{ t: "OP ENV", place: "sound", pages: [   /* a FELUCCA_FM4=1 build only */
    ...[0, 1, 2, 3].map((k) => [`OP${k + 1}`, 0, [61 + 5 * k, 62 + 5 * k, 63 + 5 * k, 64 + 5 * k]]),
    ["OP LVL", 0, [65, 70, 75, 80]]] }] : []),
  { t: "VOICE", place: "sound", pages: [["LEVEL", 0, [0]], ["VOICE", 0, [37, 38, 41, 42]], ["VOICE 2", 0, [43, 44, 39, 40]]] },
  { t: "FX", place: "sound", pages: [["FX", 0, [33, 34, 35, 36]], ["SLICER", 0, [45, 46, 47, 48]], ["DLY", 1, [4, 5, 6, 7]], ["REVERB", 1, [24, 8, 9]], ["CHORUS", 1, [10, 11]]] },
  { t: "SCL", place: "sound", pages: [["SCL", 0, [25, 26, 27, 28]], ...(pe0 >= 83 ? [["CHORD", 0, P_CHORD]] : [])] },
  { t: "ARP", place: "sound", pages: [["ARP", 0, [17, 18, 19, 20]], ["ARP 2", 0, [21, 22, 23, 24]]] },
  { t: "PATTERN", place: "seq", pages: [["PATTERN", 0, [29, 30, 31, 32]]] },
  { t: "GLOBAL", place: "settings", pages: [["GLOBAL", 1, [0, 1, 2, 3]], ["MIDI", 1, [14]]] },   /* G_ROUTE: MIDI IN */
];
/* globals that are actions or placeholders on the device: not shown */
export const G_SKIP = new Set(["SLOT", "NAME", "LOAD", "SAVE", "ENG", "SET", "CLRSQ", "INIT", "MIDI", "SYNC", "CPU", "CLK"]);
export const visible = (d) => !!d && d.max > d.min && d.label !== "-";

export const HEAD_IC = { ENV: "function_env_adsr_exp", LFO: "waveform_sine", MOD: "symbol_modular", EDIT: "ui_knob", VOICE: "symbol_keyboard",
  FX: "symbol_effector", SCL: "control_arow_scale", ARP: "control_arrow_loop", PATTERN: "symbol_grid", GLOBAL: "symbol_cog", "OP ENV": "function_env_adsr_lin" };

/* a parameter's icon by its label (the device's legacy names, tools/gen_aa_icons.py LEGACY) */
const BY_LABEL = {
  ATK: "function_env_adsr_attack", DEC: "function_env_adsr_decay", SUS: "function_env_adsr_sustain", REL: "function_env_adsr_release",
  CUT: "function_filter_lpf", CUTF: "function_filter_lpf", RES: "function_filter_lpf_peak", RATE: "symbol_speed", WAVE: "waveform_variant",
  LVL: "symbol_volume", LEVEL: "symbol_volume", PAN: "symbol_pan", MUTE: "control_speaker_mute", DLY: "symbol_echo", REV: "symbol_spring",
  CHO: "symbol_waves", DST: "function_signal_clip", GATE: "function_gate_unipolar", SWG: "symbol_swing", PROB: "symbol_dice",
  BPM: "symbol_tempo", TUNE: "symbol_tuning", PIT: "waveform_pitch", PTCH: "waveform_pitch", GLID: "symbol_transition", GLD: "symbol_transition",
  LEN: "control_arrow_end", DIV: "note_quarter", OCT: "control_arrow_up", ROOT: "symbol_keyboard", SCL: "control_arow_scale",
  HOLD: "symbol_lock_close_f", ORD: "symbol_sort", MODE: "control_arrow_loop", PHS: "function_phase", FADE: "waveform_fade",
  FB: "symbol_feedback", MIX: "symbol_combine", TIME: "symbol_clock", SIZE: "control_arrow_both", DAMP: "symbol_weight", TONE: "function_filter_band",
};
export const paramIcon = (label) => BY_LABEL[label] || null;
