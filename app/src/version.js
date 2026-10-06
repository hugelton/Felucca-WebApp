// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// Firmware versions: the device's (INFO: "FELUCCA v1.0.3", "FELUCCA 0.9 BETA") against the release the site was built
// with (make_site.py writes it into <meta name="felucca-release">) and the oldest this editor is meant for.

/* the first X.Y[.Z] in s -> [x, y, z], or null */
export function parseVersion(s) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(s || ""));
  return m ? [+m[1], +m[2], +(m[3] || 0)] : null;
}
/* a < b: -1, a == b: 0, a > b: 1 (null: 0) */
export function cmpVersion(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
/* the editor is built and tested for firmware 1.0 and later; older: the classic editor, or an update */
export const OLDEST = "1.0";
/* what to offer for a device: "classic" (older than OLDEST), "update" (older than the release), or "" */
export function advice(device, release) {
  if (!parseVersion(device)) return "";
  if (cmpVersion(device, OLDEST) < 0) return "classic";
  if (parseVersion(release) && cmpVersion(device, release) < 0) return "update";
  return "";
}
