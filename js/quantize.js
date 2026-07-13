// ── quantize: seeded k-means in CIELAB ────────────────────────────────────────
// Two changes from the RGB version, and together they remove every colour
// slider from the app.
//
// 1. CIELAB. Perceptually uniform, so plain ΔE needs no lightness/chroma
//    weight. `lumaW` is gone — it was a fudge factor for RGB's non-uniformity,
//    and it could never be right for red-vs-black and blue-vs-blue at the same
//    time. See lab.js.
//
// 2. THE TAPS ARE SEEDS, NOT REFERENCES. This is the real shift. A flat-ink
//    print, seen by a camera, doesn't produce pixels scattered around some ideal
//    colour — it produces K TIGHT CLUSTERS, one per ink, plus a thin smear of
//    edge pixels between them. That structure is already in the frame. We don't
//    have to guess where an ink sits; we can just find it.
//
//    So a tap no longer says "red is exactly RGB(200,30,40)". It says "the
//    cluster I'm pointing at is the one I want the GIF in" — a LABEL. Each
//    frame we run a k-means step against the live pixels: assign every pixel to
//    its nearest centre, then move each centre to the mean of what it caught.
//
// What that buys, all for free:
//
//   • No white-point gain. The old von Kries estimate existed to drag a FIXED
//     palette back under changing light. The palette isn't fixed any more — the
//     centres ARE the observed inks, so when the lighting shifts, the clusters
//     drift and the centres follow. The gain machinery, its EMA, its median
//     voting, and the G reset key are all deleted.
//
//   • No `soft` slider. Confidence ramps over a fraction of the distance to the
//     nearest OTHER centre. Well-separated palettes get crisp edges; tight
//     palettes get gentle ones. Correct by construction, at any palette.
//
//   • No `reject` slider. "Too far from every centre" is likewise measured
//     against the palette's own scale, not an absolute number in units nobody
//     can reason about.
//
// What survives: minArea, which isn't a colour dial at all — it's a real design
// choice about the smallest region you care about.

import { labCube, cubeIndex, CUBE, dE2, rgb2lab } from './lab.js';
import { hsv2rgb } from './hsv.js';

// Sentinel class for "this pixel belongs to no ink".
export const NO_CLASS = 255;

// ── constants (deliberately not sliders) ──────────────────────────────────────

// How fast a centre chases the cluster mean. Lighting drifts slowly; sensor
// noise doesn't. Low enough to be steady, high enough to track a lamp change.
const CENTRE_EMA = 0.15;

// A centre may not wander further than this (ΔE) from the colour that was
// actually tapped. Without an anchor, k-means is free to slide a centre off its
// ink and onto a neighbouring one — the classic bad-init failure — and the
// user's label would silently come to mean a different colour. This is the
// leash: enough slack for any plausible illuminant shift, not enough to defect.
const MAX_DRIFT = 45;

// Two centres closer than this are, for our purposes, the same ink. Freeze them
// rather than let them collapse onto each other and fight over pixels.
const MIN_SEP = 5;

// Confidence ramps over this fraction of the distance to the nearest other
// centre. A pixel wins its class outright when it beats the runner-up by that
// much; below it, alpha fades. Scale-free: it means the same thing whether the
// palette is three garish inks or two nearly identical blues.
const SOFT_FRAC = 0.35;

// A pixel further than this multiple of the nearest-neighbour separation from
// EVERY centre isn't any of the inks (a hand, deep shadow, something off-sheet).
const REJECT_MULT = 1.6;

// Temporal smoothing on the per-class membership fields. Boundary pixels flip
// class under sensor noise; without this, the media edge crawls. Smoothing the
// ALPHA — not a polygon, there isn't one — kills the shimmer at its source.
const ALPHA_EMA = 0.45;

// A cluster needs at least this many pixels before we trust its mean enough to
// move its centre. Stops a centre from chasing a handful of noise pixels when
// its ink is occluded.
const MIN_MEMBERS = 40;

// ── state ─────────────────────────────────────────────────────────────────────

let classLUT = new Uint8Array(CUBE);   // cube cell → winning class
let confLUT  = new Uint8Array(CUBE);   // cube cell → 0-255 soft membership

let pxClass = null;    // Uint8Array(n)
let pxConf  = null;    // Uint8Array(n)
let alpha   = [];      // Float32Array(n) per class — the EMA'd stencil field

// Live cluster centres in Lab, and the seeds they're leashed to.
let centres = [];      // [{ L, a, b }]
let seeds   = [];      // [{ L, a, b }] — from the taps; never move
let seedKey = '';      // signature of the calibration the centres were seeded from

export function resetClusters() { seedKey = ''; centres = []; seeds = []; }

export function allocQuantBuffers(w, h, nClasses) {
  const n = w * h;
  pxClass = new Uint8Array(n);
  pxConf  = new Uint8Array(n);
  alpha = Array.from({ length: nClasses }, () => new Float32Array(n));
}

// ── palette ───────────────────────────────────────────────────────────────────
// One entry per calibrated slot. Configs saved before the RGB refactor carry
// only h/s/v, so reconstruct RGB from those — a lossy seed, but k-means only
// needs to land in the right cluster's basin, and then it walks itself to the
// true centre. That's a nice property of this design: a rough seed self-corrects
// in a few frames, where the old fixed-reference model would have stayed wrong
// forever.
export function buildPalette(calibrated) {
  const palette = [];
  for (let i = 0; i < calibrated.length; i++) {
    const c = calibrated[i];
    if (!c) continue;
    let { r, g, b } = c;
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      [r, g, b] = hsv2rgb(c.h, c.s, c.v);
    }
    palette.push({ pi: i, r, g, b });
  }
  return palette;
}

function paletteKey(palette) {
  let s = '';
  for (const p of palette) s += `${p.pi}:${p.r},${p.g},${p.b};`;
  return s;
}

// (Re)seed the centres from the taps whenever the calibration changes.
function ensureSeeded(palette) {
  const key = paletteKey(palette);
  if (key === seedKey) return;
  seeds = palette.map(p => {
    const [L, a, b] = rgb2lab(p.r, p.g, p.b);
    return { L, a, b };
  });
  centres = seeds.map(s => ({ L: s.L, a: s.a, b: s.b }));
  seedKey = key;
}

// Distance from each centre to its nearest neighbouring centre. This is the
// palette's own length scale, and it's what lets softness and rejection be
// derived rather than dialled: everything is measured relative to how far apart
// THIS palette's colours actually are.
function separations() {
  const k = centres.length;
  const sep = new Float32Array(k);
  for (let i = 0; i < k; i++) {
    let best = Infinity;
    for (let j = 0; j < k; j++) {
      if (i === j) continue;
      const d = Math.sqrt(dE2(
        centres[i].L, centres[i].a, centres[i].b,
        centres[j].L, centres[j].a, centres[j].b));
      if (d < best) best = d;
    }
    // A lone colour has no neighbour; give it a sane default scale so its
    // softness and rejection still behave.
    sep[i] = (k < 2 || !Number.isFinite(best)) ? 40 : Math.max(MIN_SEP, best);
  }
  return sep;
}

// ── the cube bake ─────────────────────────────────────────────────────────────
// For every cell of the 5-bit RGB cube, find the nearest centre and how
// decisively it won. Rebuilt every frame because the centres move every frame —
// but that's only 32768 × k distance evaluations, cheaper than classifying
// 77k pixels against k centres directly, and it makes the per-pixel loop a
// single array read.
function bakeLUT(sep) {
  const k = centres.length;
  const cL = new Float32Array(k), cA = new Float32Array(k), cB = new Float32Array(k);
  for (let c = 0; c < k; c++) { cL[c] = centres[c].L; cA[c] = centres[c].a; cB[c] = centres[c].b; }

  for (let cell = 0, li = 0; cell < CUBE; cell++, li += 3) {
    const L = labCube[li], a = labCube[li + 1], b = labCube[li + 2];

    let d1 = Infinity, d2 = Infinity, win = 0;
    for (let c = 0; c < k; c++) {
      const d = dE2(L, a, b, cL[c], cA[c], cB[c]);
      if (d < d1) { d2 = d1; d1 = d; win = c; }
      else if (d < d2) { d2 = d; }
    }

    const nearest = Math.sqrt(d1);
    if (nearest > sep[win] * REJECT_MULT) {
      classLUT[cell] = NO_CLASS;
      confLUT[cell] = 0;
      continue;
    }

    let conf = 255;
    if (k > 1) {
      const margin = Math.sqrt(d2) - nearest;
      const ramp = Math.max(1, sep[win] * SOFT_FRAC);
      conf = Math.max(0, Math.min(255, Math.round((margin / ramp) * 255)));
    }
    classLUT[cell] = win;
    confLUT[cell] = conf;
  }
}

// ── the frame pass ────────────────────────────────────────────────────────────
// img: RGBA from getImageData. Assigns every pixel, folds the result into the
// per-class EMA alpha fields, and takes one k-means step so the centres track
// the real inks. Read the result via classAlpha(c).
export function quantizeFrame(img, palette, w, h) {
  const n = w * h;
  const k = palette.length;
  if (!k || !pxClass || pxClass.length !== n) return;

  ensureSeeded(palette);
  const sep = separations();
  bakeLUT(sep);

  // k-means accumulators, in Lab
  const sL = new Float64Array(k), sA = new Float64Array(k), sB = new Float64Array(k);
  const cnt = new Float64Array(k);

  for (let p = 0, q = 0; p < n; p++, q += 4) {
    const cell = cubeIndex(img[q], img[q + 1], img[q + 2]);
    const c = classLUT[cell];
    const conf = confLUT[cell];
    pxClass[p] = c;
    pxConf[p] = conf;

    // Only confident pixels move the centres. Boundary pixels are literally a
    // blend of two inks — averaging them in would drag every centre toward its
    // neighbours, and over enough frames the whole palette would implode toward
    // its own mean. Excluding them is what keeps k-means stable here.
    if (c !== NO_CLASS && conf > 200) {
      const li = cell * 3;
      sL[c] += labCube[li]; sA[c] += labCube[li + 1]; sB[c] += labCube[li + 2];
      cnt[c]++;
    }
  }

  // EMA the per-class membership fields. Done for every class, not just the
  // winner, so a class fades OUT smoothly where it loses ground instead of
  // snapping to zero.
  for (let c = 0; c < k; c++) {
    const f = alpha[c];
    for (let p = 0; p < n; p++) {
      const target = (pxClass[p] === c) ? pxConf[p] / 255 : 0;
      f[p] += (target - f[p]) * ALPHA_EMA;
    }
  }

  stepCentres(sL, sA, sB, cnt);
}

// One k-means update, leashed. Each centre eases toward the mean of the pixels
// it caught — but never further than MAX_DRIFT from the colour that was tapped,
// which is what stops a centre from sliding off its ink onto a neighbour's and
// silently redefining what the user's label means.
function stepCentres(sL, sA, sB, cnt) {
  const k = centres.length;
  for (let c = 0; c < k; c++) {
    if (cnt[c] < MIN_MEMBERS) continue;   // ink occluded — hold position

    const mL = sL[c] / cnt[c], mA = sA[c] / cnt[c], mB = sB[c] / cnt[c];

    let nL = centres[c].L + (mL - centres[c].L) * CENTRE_EMA;
    let nA = centres[c].a + (mA - centres[c].a) * CENTRE_EMA;
    let nB = centres[c].b + (mB - centres[c].b) * CENTRE_EMA;

    // leash to the seed
    const s = seeds[c];
    const d = Math.sqrt(dE2(nL, nA, nB, s.L, s.a, s.b));
    if (d > MAX_DRIFT) {
      const t = MAX_DRIFT / d;
      nL = s.L + (nL - s.L) * t;
      nA = s.a + (nA - s.a) * t;
      nB = s.b + (nB - s.b) * t;
    }

    centres[c] = { L: nL, a: nA, b: nB };
  }

  // Don't let two centres collapse onto each other. If they've closed to within
  // MIN_SEP, push them back to their seeds — a degenerate palette (the same ink
  // tapped twice) should stay stable and separate, not oscillate.
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const d = Math.sqrt(dE2(
        centres[i].L, centres[i].a, centres[i].b,
        centres[j].L, centres[j].a, centres[j].b));
      if (d < MIN_SEP) {
        centres[i] = { L: seeds[i].L, a: seeds[i].a, b: seeds[i].b };
        centres[j] = { L: seeds[j].L, a: seeds[j].a, b: seeds[j].b };
      }
    }
  }
}

// The EMA'd 0-1 membership field for palette index c. Live buffer — read it,
// don't retain it.
export function classAlpha(c) { return alpha[c]; }
export function pixelClasses() { return pxClass; }