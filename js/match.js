// ── match: global-registration colour matching ───────────────────────────────
// Relative palette matching. Instead of thresholding each piece against an
// absolute calibrated colour (brittle across phones / lighting), we treat the
// stored per-piece hues as a *reference palette* and find the single global
// hue rotation θ that best lands that palette onto the colours actually seen
// this frame, then assign blobs to pieces under that rotation. θ absorbs both
// the illuminant (white balance) and the sensor — so one config authored in
// one room plays anywhere, and per-session recalibration goes away.
//
// θ is *session* state, not per-frame: real lighting doesn't change frame to
// frame, so we estimate θ whenever ≥2 pieces are visible (2 points fix a
// rotation), smooth it, and reuse it. A lone visible piece is then identified
// under the remembered θ instead of guessing from a single ambiguous point.
//
// This module is pure: no DOM, no pixel buffers. It takes lists of {hue,sat}
// and returns an assignment. tracker.js owns the pixels and calls in here.

import { hueDiff360 } from './hsv.js';

// Saturation's weight relative to hue in the match cost. Hue is the primary
// signal; sat is a secondary axis that separates near-identical hues (e.g. the
// butterfly config's 290°/326° pair) and is fairly illumination-stable on a
// white ground. Hue diff is in degrees (0-180); sat diff is 0-1, so we scale
// it up to sit in comparable units. 1.0 of sat diff ≈ 60° of hue-diff cost.
const SAT_WEIGHT = 60;

// Last-known-position tiebreak. A small pull toward the blob nearest a piece's
// previous centroid, in cost per (fraction-of-frame-width of distance). Only
// applied when a previous centroid exists. Keeps stable pieces stable and
// breaks near-ties (the 290/326 pair) in favour of continuity. This is a soft
// penalty, not the hard MAX_JUMP gate the per-piece path used — a much better
// colour match can still win over position, which is what we want when a piece
// is picked up and moved fast.
const POS_WEIGHT = 30;

// Reject a matched pair whose residual cost exceeds this (same mixed units as
// the cost). Roughly "hue off by ~30° with no sat/pos help" — that's a hand, a
// stray coloured object, or a genuinely absent piece. Unmatched pieces read as
// a miss this frame, exactly like the old detector returning null.
const REJECT_COST = 30;

// EMA factor for smoothing θ across frames (0..1; higher = snappier, jitterier).
const THETA_EMA = 0.25;

// Session θ in degrees, null until first established from ≥2 visible pieces.
let theta = null;

export function resetTheta() { theta = null; }
export function getTheta() { return theta; }

// Normalise degrees to [-180, 180).
function normDeg(d) {
  d = ((d + 180) % 360 + 360) % 360 - 180;
  return d;
}

// Signed shortest angular step from a toward b, in (-180, 180]. Used to EMA a
// circular quantity correctly (a plain lerp breaks across the 0/360 seam).
function shortestSignedDiff(a, b) {
  return normDeg(b - a);
}

// Cost of matching palette entry p to observed blob o under rotation th.
// p.prevCentroid (proc-space [x,y]) + frameW enable the position tiebreak.
function pairCost(p, o, th, frameW) {
  let cost = hueDiff360(p.h + th, o.hue) + SAT_WEIGHT * Math.abs(p.s - o.sat);
  if (p.prevCentroid) {
    const d = Math.hypot(o.cx - p.prevCentroid[0], o.cy - p.prevCentroid[1]) / frameW;
    cost += POS_WEIGHT * d;
  }
  return cost;
}

// Greedy assignment of palette → observed at a fixed θ. Returns
// { pairs: [{pi, oi, cost}], total }. Greedy = take the lowest-cost pair,
// remove its row+col, repeat. Optimal enough for a small, well-separated
// palette; if tight palettes ever need it, this is the single spot to drop in
// Hungarian without touching anything else.
function assignAt(palette, observed, th, frameW) {
  const usedO = new Uint8Array(observed.length);
  const usedP = new Uint8Array(palette.length);
  const pairs = [];
  let total = 0;
  const k = Math.min(palette.length, observed.length);
  for (let step = 0; step < k; step++) {
    let best = null;
    for (let pi = 0; pi < palette.length; pi++) {
      if (usedP[pi]) continue;
      for (let oi = 0; oi < observed.length; oi++) {
        if (usedO[oi]) continue;
        const c = pairCost(palette[pi], observed[oi], th, frameW);
        if (!best || c < best.cost) best = { pi, oi, cost: c };
      }
    }
    if (!best) break;
    usedO[best.oi] = 1; usedP[best.pi] = 1;
    pairs.push(best); total += best.cost;
  }
  return { pairs, total };
}

// Estimate the best θ from scratch: coarse 2° sweep + a 0.25° local refine,
// each candidate scored by its greedy-assignment total. Used to (re)acquire θ.
// For N ≤ 7 pieces and a handful of blobs this is a few tens of thousands of
// cheap ops per frame — negligible — and only runs when ≥2 pieces are visible.
function estimateTheta(palette, observed, frameW) {
  let best = null;
  for (let th = -180; th < 180; th += 2) {
    const { total } = assignAt(palette, observed, th, frameW);
    if (!best || total < best.total) best = { th, total };
  }
  const c = best.th;
  for (let th = c - 2; th <= c + 2; th += 0.25) {
    const { total } = assignAt(palette, observed, th, frameW);
    if (total < best.total) best = { th, total };
  }
  return best.th;
}

// Match observed blobs to the active palette.
//   palette : [{ pi, h, s, prevCentroid }]  (one per non-null calibrated piece)
//   observed: [{ oi, hue, sat, cx, cy, area, label, start }]
//   frameW  : proc-frame width (for the position tiebreak scale)
// Returns a Map  pieceIndex → observed-blob. Unmatched pieces are simply
// absent from the map (caller treats absence as a miss for that piece).
export function registerBlobs(palette, observed, frameW) {
  const result = new Map();
  if (!palette.length || !observed.length) return result;

  // Choose θ. With ≥2 observed blobs and ≥2 palette entries we can fix a global
  // rotation from this frame and fold it into the session estimate. With fewer,
  // this frame can't determine a rotation, so we lean on the remembered θ — or,
  // if we've never had one, provisionally assume 0 (trust the stored palette
  // roughly, and let it self-correct the instant a 2nd piece appears).
  let thUse;
  if (observed.length >= 2 && palette.length >= 2) {
    const est = estimateTheta(palette, observed, frameW);
    theta = (theta === null) ? est
                             : normDeg(theta + shortestSignedDiff(theta, est) * THETA_EMA);
    thUse = theta;
  } else {
    thUse = (theta === null) ? 0 : theta;
  }

  // Final assignment at the chosen θ, with rejection gating.
  const { pairs } = assignAt(palette, observed, thUse, frameW);
  for (const { pi, oi, cost } of pairs) {
    if (cost > REJECT_COST) continue;
    result.set(palette[pi].pi, observed[oi]);
  }
  return result;
}