// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// A user sample slot's draft before it is written: up to 16 zones (files or recordings), each the raw input at
// 22050 Hz, its trim [a, b), its root note; the keys split between the roots; the size against the slot. No DOM:
// the page adds decoded audio; buildSlot (proto.js) makes the header and the ADPCM the device takes.

import { SMP, autoTrim, buildSlot, parseWav, resample, rootFromName, takeSample } from "./proto.js";

export const MAX_DATA = SMP.MAX_DATA;
export const NAME_MAX = 8;
export const cleanName = (s) => String(s || "").toUpperCase().replace(/[^\x20-\x7E]/g, "").slice(0, NAME_MAX);
/* at least 10 ms between the ends */
const MIN = Math.round(SMP.RATE * 0.01);

/* the keys each zone plays: split half-way between neighbouring roots (as buildSlot does) */
export function splitKeys(roots) {
  const z = roots.map((root, i) => ({ i, root })).sort((a, b) => a.root - b.root);
  const out = [];
  z.forEach((x, j) => {
    out[x.i] = [j === 0 ? 0 : Math.floor((z[j - 1].root + x.root) / 2) + 1, j === z.length - 1 ? 127 : Math.floor((x.root + z[j + 1].root) / 2)];
  });
  return out;
}

/* bytes (a WAV, or anything the browser decodes: decode) -> raw mono at 22050 Hz */
export async function decodeAudio(buf, decode) {
  let x;
  try {
    const w = parseWav(buf);
    x = resample(w.x, w.sr, SMP.RATE);
  } catch (e) {
    if (!decode) throw e;
    x = await decode(buf);                          /* (already mono at SMP.RATE) */
  }
  if (!x.length) throw new Error("no audio");
  return Float64Array.from(x);
}

export class Draft {
  constructor() { this.name = ""; this.zones = []; }
  get bytes() { return this.zones.reduce((n, z) => n + ((z.s.length + 1) >> 1), 0); }
  get tooBig() { return this.bytes > MAX_DATA; }
  get full() { return this.zones.length >= SMP.MAX_ZONES; }
  get keys() { return splitKeys(this.zones.map((z) => z.root)); }
  setName(s) { this.name = cleanName(s); return this.name; }
  /* raw: mono at SMP.RATE; trim: true = autoTrim (a recording), else the whole */
  add(fname, raw, { root, trim = false } = {}) {
    if (this.full) return null;
    const [a, b] = trim ? autoTrim(raw) : [0, raw.length];
    const z = { fname, raw, a, b, s: takeSample(raw, a, b), root: root ?? rootFromName(String(fname).replace(/\.[^.]*$/, "")) ?? 60 };
    this.zones.push(z);
    if (!this.name) this.setName(String(fname).replace(/\.[^.]*$/, ""));
    return z;
  }
  remove(i) { this.zones.splice(i, 1); }
  clear() { this.zones = []; }
  /* the ends of zone i (samples of raw); kept at least 10 ms apart, inside raw */
  trim(i, a, b) {
    const z = this.zones[i], n = z.raw.length;
    a = Math.max(0, Math.min(Math.round(a), n - MIN));
    b = Math.min(n, Math.max(Math.round(b), a + MIN));
    z.a = a; z.b = b;
    z.s = takeSample(z.raw, a, b);
    return z;
  }
  autoTrim(i) { const [a, b] = autoTrim(this.zones[i].raw); return this.trim(i, a, b); }
  setRoot(i, n) { if (Number.isInteger(n) && n >= 0 && n <= 127) this.zones[i].root = n; return this.zones[i].root; }
  /* -> {hdr, data} for the device (throws when it does not fit) */
  build() { return buildSlot(this.name, this.zones.map((z) => ({ s: z.s, root: z.root }))); }
}
