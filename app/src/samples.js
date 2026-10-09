// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// A user sample slot's draft before it is written: up to 16 zones (files or recordings), each the raw input at
// 22050 Hz (and at 44100 Hz when the file has it), its trim [a, b), its root note; the keys split between the roots;
// the slot's RATE (44100 / 22050 / 11025 / 5512 Hz: the header's per-zone rate, the device plays each at its pitch)
// and BITS (a lo-fi crush of the audio before it is encoded; what is stored stays the device's ADPCM); the size against
// the slot. No DOM: the page adds decoded audio; buildSlot (proto.js) makes the header and the ADPCM the device takes.

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

/* bytes (a WAV, or anything the browser decodes: decode(buf, rate)) -> raw mono at rate (22050 Hz: what a slot
   has always stored) */
export async function decodeAudio(buf, decode, rate = SMP.RATE) {
  let x;
  try {
    const w = parseWav(buf);
    x = resample(w.x, w.sr, rate);
  } catch (e) {
    if (!decode) throw e;
    x = await decode(buf, rate);                    /* (already mono at rate) */
  }
  if (!x.length) throw new Error("no audio");
  return Float64Array.from(x);
}

/* the slot's sample rates (Hz) and bit depths offered; the first of each is what the editor always did */
export const RATES = [22050, 44100, 11025, 5512];
export const BITS = [16, 12, 8, 6, 4];
/* x (int16-scale floats) kept to bits: each value rounded to 2^(16 - bits) */
export function crush(x, bits) {
  if (bits >= 16) return x;
  const q = 2 ** (16 - bits), y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] / q) * q));
  return y;
}

export class Draft {
  constructor() { this.name = ""; this.zones = []; this.rate = RATES[0]; this.bits = BITS[0]; }
  /* 44100 Hz only when every zone has its audio at that rate (a file; a recording is taken at 22050) */
  get hiOk() { return this.zones.length > 0 && this.zones.every((z) => z.raw44); }
  get rateUsed() { return this.rate === 44100 && !this.hiOk ? SMP.RATE : this.rate; }
  setRate(r) { if (RATES.includes(r)) this.rate = r; return this.rateUsed; }
  setBits(b) { if (BITS.includes(b)) this.bits = b; return this.bits; }
  /* zone z as it will be stored: its trim at the slot's rate, crushed to the slot's bits */
  render(z) {
    const r = this.rateUsed;
    const s = r === 44100 ? takeSample(z.raw44, z.a * 2, z.b * 2) : r === SMP.RATE ? z.s : resample(z.s, SMP.RATE, r);
    return crush(s, this.bits);
  }
  get bytes() { return this.zones.reduce((n, z) => n + ((this.render(z).length + 1) >> 1), 0); }
  get tooBig() { return this.bytes > MAX_DATA; }
  get full() { return this.zones.length >= SMP.MAX_ZONES; }
  get keys() { return splitKeys(this.zones.map((z) => z.root)); }
  setName(s) { this.name = cleanName(s); return this.name; }
  /* raw: mono at SMP.RATE (raw44: the same at 44100 Hz, when there is one); trim: true = autoTrim (a recording), else
     the whole */
  add(fname, raw, { root, trim = false, raw44 = null } = {}) {
    if (this.full) return null;
    const [a, b] = trim ? autoTrim(raw) : [0, raw.length];
    const z = { fname, raw, raw44: raw44 && raw44.length >= raw.length * 2 - 2 ? raw44 : null, a, b, s: takeSample(raw, a, b),
      root: root ?? rootFromName(String(fname).replace(/\.[^.]*$/, "")) ?? 60 };
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
  build() { return buildSlot(this.name, this.zones.map((z) => ({ s: this.render(z), root: z.root })), this.rateUsed); }
}
