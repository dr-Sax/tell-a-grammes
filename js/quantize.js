// ── quantize: per-pixel nearest-palette classification ────────────────────────
// Replaces the old HSV band-per-piece approach. Every calibrated colour is a
// palette entry, and every pixel is assigned to the entry it is NEAREST to —
// a competition, not N independent tolerance boxes. That single change is what
// lets two near-identical blues (the "Ey Es" marker) separate cleanly: the
// decision boundary between them lands on their perpendicular bisector for
// free, with no tolerance tuning at all.
//
// Three things sit on top of the bare argmin:
//
//   1. WHITE-POINT GAIN. A per-channel (von Kries) gain, estimated each frame
//      by comparing every class's observed mean RGB to its calibrated
//      reference, and EMA-smoothed across frames. This is what absorbs
//      lighting / white-balance / device drift, and it replaces match.js's
//      global hue rotation θ. It's strictly stronger than θ was (it corrects
//      tint AND exposure, not just hue) and it's ~20 lines. Chicken-and-egg is
//      resolved the usual way: classify with the PREVIOUS frame's gain, then
//      refine. Lighting doesn't change frame to frame, so this is exact enough.
//
//   2. SOFT MEMBERSHIP. argmin also hands us the runner-up distance, so we get
//      a confidence for free: how much better is the winner than second place?
//      Pixels deep inside a colour score 1.0; pixels straddling a boundary (or
//      sitting on an anti-aliased print edge) fade toward 0. That's antialiasing
//      and ambiguity-rejection in one number, and it's why the stencil edges
//      come out smooth instead of stair-stepped.
//
//   3. TEMPORAL EMA. A per-class Float32 alpha field, EMA'd frame to frame.
//      Boundary pixels flip class under sensor noise; without this the media
//      edge crawls. Smoothing the ALPHA (not the polygon, which no longer
//      exists) kills the shimmer at its source.
//
// The hot loop is a lookup, not arithmetic: we precompute a 5-bit RGB cube
// (32768 entries → class + confidence) whenever the palette or gain moves, so
// per-pixel work is two array reads. Rebuilding the cube costs ~33k distance
// evaluations; classifying naively would cost 77k × N. The LUT wins by ~20×
// AND is less code.

import { params } from './config.js';
import { hsv2rgb } from './hsv.js';

// 5 bits per channel: 32 levels, 32768 cube entries. Quantization error is
// ~4/255 per channel — comfortably under camera sensor noise, and the soft
// membership above smooths right over it.
const BITS = 5;
const LEVELS = 1 << BITS;              // 32
const CUBE = LEVELS * LEVELS * LEVELS; // 32768
const SHIFT = 8 - BITS;                // 3

// Sentinel class for "nothing in the palette is close enough".
export const NO_CLASS = 255;

let classLUT = new Uint8Array(CUBE);
let confLUT  = new Uint8Array(CUBE);

// Per-pixel scratch (allocated in allocBuffers)
let pxClass = null;   // Uint8Array(n)  — winning class index, or NO_CLASS
let pxConf  = null;   // Uint8Array(n)  — 0-255 soft membership
let alpha   = [];     // Float32Array(n) per class — the EMA'd stencil field

// Session white-point gain (per channel). Multiplies the OBSERVED pixel to
// bring it back onto the calibrated reference. Persisted across frames.
let gain = [1, 1, 1];
let lastGain = [0, 0, 0];   // the gain the current LUT was baked with
let lutKey = '';            // palette+params signature the LUT was baked with

export function resetGain() { gain = [1, 1, 1]; lastGain = [0, 0, 0]; lutKey = ''; }
export function getGain() { return gain.slice(); }

export function allocQuantBuffers(w, h, nClasses) {
  const n = w * h;
  pxClass = new Uint8Array(n);
  pxConf  = new Uint8Array(n);
  alpha = Array.from({ length: nClasses }, () => new Float32Array(n));
}

// ── palette ───────────────────────────────────────────────────────────────────
// Build the active palette from state.calibrated. Entries carry their piece
// index so the caller can map class → piece. Old configs saved before this
// refactor only have { h, s, v }, so we derive RGB from them — a lossy but
// perfectly usable starting point that gets refined the moment the user
// re-taps a piece.
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

// ── distance ──────────────────────────────────────────────────────────────────
// Squared distance in a luma/chroma-weighted space. No sqrt — argmin over d²
// gives the identical winner, and we only take a root once at the very end for
// the confidence margin.
//
// params.lumaW is the single dial that used to be htol/stol/vtol:
//   lumaW = 1   → essentially plain RGB distance. Brightness counts fully.
//   lumaW → 0   → chroma only; brightness ignored (shading-proof, but then
//                 light-blue and dark-blue MERGE, and white/grey/black become
//                 indistinguishable).
// For a printed marker under steady light — which is exactly this case — you
// WANT brightness to count: it's the only axis separating the two Ey Es blues,
// and it's the only axis that exists at all for white/black. So the default is
// high. The dial is there for the day the lighting stops cooperating.
function dist2(dr, dg, db, lumaW) {
  const dY = 0.299 * dr + 0.587 * dg + 0.114 * db;
  const cr = dr - dY, cg = dg - dY, cb = db - dY;
  return cr * cr + cg * cg + cb * cb + lumaW * 3 * dY * dY;
}

// ── LUT bake ──────────────────────────────────────────────────────────────────
// For every cell of the 5-bit RGB cube, find the nearest palette entry and how
// decisively it won. Baked against the palette PRE-DIVIDED by the current gain,
// which is equivalent to gain-correcting every pixel but costs O(palette)
// instead of O(pixels).
function bakeLUT(palette) {
  const lumaW = params.lumaW;
  const soft = Math.max(1, params.soft);
  const reject2 = params.reject * params.reject;
  const k = palette.length;

  // reference colours in observed space (i.e. undo the gain on the refs)
  const rr = new Float32Array(k), rg = new Float32Array(k), rb = new Float32Array(k);
  for (let c = 0; c < k; c++) {
    rr[c] = palette[c].r / gain[0];
    rg[c] = palette[c].g / gain[1];
    rb[c] = palette[c].b / gain[2];
  }

  const step = 255 / (LEVELS - 1);
  let idx = 0;
  for (let ri = 0; ri < LEVELS; ri++) {
    const r = ri * step;
    for (let gi = 0; gi < LEVELS; gi++) {
      const g = gi * step;
      for (let bi = 0; bi < LEVELS; bi++, idx++) {
        const b = bi * step;

        let d1 = Infinity, d2 = Infinity, win = NO_CLASS;
        for (let c = 0; c < k; c++) {
          const d = dist2(r - rr[c], g - rg[c], b - rb[c], lumaW);
          if (d < d1) { d2 = d1; d1 = d; win = c; }
          else if (d < d2) { d2 = d; }
        }

        if (win === NO_CLASS || d1 > reject2) {
          classLUT[idx] = NO_CLASS;
          confLUT[idx] = 0;
          continue;
        }

        // Confidence = how far ahead the winner is, in plain distance units,
        // ramped over `soft`. One palette entry → always fully confident.
        let conf = 255;
        if (k > 1) {
          const margin = Math.sqrt(d2) - Math.sqrt(d1);
          conf = Math.max(0, Math.min(255, Math.round((margin / soft) * 255)));
        }
        classLUT[idx] = win;
        confLUT[idx] = conf;
      }
    }
  }
}

function paletteKey(palette) {
  let s = `${params.lumaW}|${params.soft}|${params.reject}|`;
  for (const p of palette) s += `${p.pi}:${p.r | 0},${p.g | 0},${p.b | 0};`;
  return s;
}

// Re-bake only when something actually moved. The gain drifts by tiny amounts
// every frame under EMA, so we gate on a threshold rather than exact equality —
// otherwise we'd rebuild 30×/sec for a change too small to alter any decision.
function ensureLUT(palette) {
  const key = paletteKey(palette);
  const moved =
    Math.abs(gain[0] - lastGain[0]) > 0.004 ||
    Math.abs(gain[1] - lastGain[1]) > 0.004 ||
    Math.abs(gain[2] - lastGain[2]) > 0.004;
  if (key === lutKey && !moved) return;
  bakeLUT(palette);
  lutKey = key;
  lastGain = gain.slice();
}

// ── the frame pass ────────────────────────────────────────────────────────────
// img: RGBA Uint8ClampedArray from getImageData. Classifies every pixel, folds
// the result into the per-class EMA alpha fields, and updates the gain estimate
// for next frame. Returns nothing — read the fields via classAlpha(c).
export function quantizeFrame(img, palette, w, h) {
  const n = w * h;
  const k = palette.length;
  if (!k || !pxClass || pxClass.length !== n) return;

  ensureLUT(palette);

  // Accumulators for the gain estimate: per-class mean observed RGB.
  const sr = new Float64Array(k), sg = new Float64Array(k), sb = new Float64Array(k);
  const cnt = new Float64Array(k);

  for (let p = 0, q = 0; p < n; p++, q += 4) {
    const r = img[q], g = img[q + 1], b = img[q + 2];
    const li = ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    const c = classLUT[li];
    pxClass[p] = c;
    const conf = confLUT[li];
    pxConf[p] = conf;

    // Only high-confidence pixels vote on the gain — boundary/ambiguous pixels
    // are exactly the ones whose colour is a blend of two references, and
    // averaging those in would bias every class toward its neighbours.
    if (c !== NO_CLASS && conf > 200) {
      sr[c] += r; sg[c] += g; sb[c] += b; cnt[c]++;
    }
  }

  // EMA the per-class alpha fields. `target` is the soft membership if this
  // pixel won for that class, else 0. Doing it per class (rather than only for
  // the winner) is what makes a class fade OUT smoothly when it loses a pixel,
  // instead of snapping to zero.
  const a = Math.max(0.01, Math.min(1, params.ema));
  for (let c = 0; c < k; c++) {
    const f = alpha[c];
    for (let p = 0; p < n; p++) {
      const target = (pxClass[p] === c) ? pxConf[p] / 255 : 0;
      f[p] += (target - f[p]) * a;
    }
  }

  updateGain(palette, sr, sg, sb, cnt);
}

// Diagonal (von Kries) white-point correction. For each class with enough
// confident pixels we get a per-channel ratio ref/observed; the frame's gain is
// the MEDIAN of those ratios across classes, which is robust to one class being
// blown out by a specular hotspot or clipped to black. Then EMA into the
// session gain — real lighting doesn't jump, so we want a slow, steady estimate,
// not a per-frame twitch.
//
// Note this needs no dedicated white patch: any known reference colour tells
// you how the illuminant is distorting the channels. Using all of them and
// taking the median is both simpler and sturdier than trusting one white swatch.
const GAIN_EMA = 0.08;
const MIN_VOTES = 60;   // proc-px of confident coverage before a class may vote

function median(arr) {
  if (!arr.length) return 1;
  const s = arr.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function updateGain(palette, sr, sg, sb, cnt) {
  const gr = [], gg = [], gb = [];
  for (let c = 0; c < palette.length; c++) {
    if (cnt[c] < MIN_VOTES) continue;
    const or_ = sr[c] / cnt[c], og = sg[c] / cnt[c], ob = sb[c] / cnt[c];
    // A near-zero observed channel (a black class's blue, say) gives a wild
    // ratio — skip those rather than let them dominate the median.
    if (or_ > 12 && palette[c].r > 12) gr.push(palette[c].r / or_);
    if (og  > 12 && palette[c].g > 12) gg.push(palette[c].g / og);
    if (ob  > 12 && palette[c].b > 12) gb.push(palette[c].b / ob);
  }
  if (gr.length < 2 || gg.length < 2 || gb.length < 2) return;  // not enough to fix a gain

  const target = [median(gr), median(gg), median(gb)];
  for (let i = 0; i < 3; i++) {
    // clamp: a gain outside ~±60% means something is badly wrong (a hand over
    // the whole marker, the lights off) — don't let a bad frame poison θ's
    // successor the way a single bad estimate could.
    const t = Math.max(0.6, Math.min(1.6, target[i]));
    gain[i] += (t - gain[i]) * GAIN_EMA;
  }
}

// The EMA'd 0-1 membership field for class index c (indexes into the palette
// array, NOT the piece array). Live buffer — read it, don't keep it.
export function classAlpha(c) { return alpha[c]; }
export function pixelClasses() { return pxClass; }