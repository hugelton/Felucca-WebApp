// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// CUSTOM, the user's palette (1.6, EDITOR_PROTOCOL.md "CUSTOM palette"): the tokens the device derives from the five
// colours a palette stores (BG SURF TEXT THEME ACCENT, RGB565), and the colour conversions of the page. A port of
// felucca/src/gfx.c (ux_mix, palette_set): the editor shows what the device will draw. The rule for colours that are
// readable and the built-in palettes are in proto.js (the protocol section: the mock device keeps the same rule).

import { PAL_BUILTIN, PAL_ROLES, PAL_RULE, palLuma, palReadable, palUnreadable } from "./proto.js";

export const ROLES = PAL_ROLES;
export const BUILTIN = PAL_BUILTIN;
export const RULE = PAL_RULE;
export const luma = palLuma;
export const readable = palReadable;
export const unreadable = palUnreadable;

/* RGB565 <-> the three 7-bit bytes of the protocol (red 0..31, green 0..63, blue 0..31) and a #rrggbb string */
export const rgb565 = (r, g, b) => (r >> 3) << 11 | (g >> 2) << 5 | b >> 3;               /* 8-bit channels */
export const bytes = (c) => [c >> 11, (c >> 5) & 63, c & 31];
export const fromBytes = (r, g, b) => r << 11 | g << 5 | b;
export const to8 = (c) => [(c >> 11) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31].map(Math.round);
export const hex = (c) => "#" + to8(c).map((x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (s) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(s));
  return m ? rgb565(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)) : 0;
};

const PCT = { mid: 70, dim: 42, line: 18, sel: 80, tint: 12, key: 78, raise: 12 };   /* UI_*_PCT */
const REC_DARK = 0xfa49, REC_LIGHT = 0xb8c5;
const SH = [11, 5, 0], MK = [31, 63, 31];

/* a + (b - a) * pct / 100 per channel, rounded half away from zero (C's integer division truncates) */
export function mix(a, b, pct) {
  let out = 0;
  for (let k = 0; k < 3; k++) {
    const x = (a >> SH[k]) & MK[k], d = (((b >> SH[k]) & MK[k]) - x) * pct;
    out |= (x + Math.trunc((d + (d >= 0 ? 50 : -50)) / 100)) << SH[k];
  }
  return out & 0xFFFF;
}

/* the tokens of a CUSTOM palette in the FLAT style (gfx.c palette_set: not GREY, not MONO) */
export function derive(c) {
  const [bg, surf, text, theme, accent] = c, light = palLuma(bg) > 128;
  return {
    bg, surf, text, theme, accent,
    mid: mix(bg, text, PCT.mid), dim: mix(bg, text, PCT.dim), line: mix(bg, text, PCT.line),
    sel: mix(bg, theme, PCT.sel), tint: mix(bg, theme, PCT.tint), ink: bg,
    raise: mix(surf, text, PCT.raise), key: mix(bg, text, PCT.key),
    lane: mix(surf, theme, 10), grid: mix(surf, text, 6), rec: light ? REC_LIGHT : REC_DARK, light,
  };
}
