// ── detect: camera pixels → per-colour stencils ───────────────────────────────
// The whole detection system in one module. The pipeline, per frame:
//
//   histogram the frame over a 5-bit Lab cube (lab.js)
//     → k-means discovers the frame's colour clusters, unsupervised
//     → each calibrated tap CLAIMS its nearest cluster group; the rest are
//       background
//     → every pixel gets an owner + a soft 0-1 membership, EMA'd over time
//     → per colour: membership field → RGBA stencil that render.js pours
//       media through (destination-in)
//
// The relationship between a tap and a colour is inverted from classic
// calibration. A tap doesn't DEFINE a colour with tolerance bands around it —
// nearest-neighbour over taps partitions ALL of colour space, with no "none of
// the above", so paper/skin/shadow would be handed to whichever ink they sit
// closest to. (White paper is only ΔE 17 from a light blue; it never stood a
// chance.) Instead, k-means finds every colour actually present — inks, paper,
// shadow — and a tap simply claims the cluster nearest to it. Unclaimed
// clusters compete for their own pixels and draw nothing, which is what keeps
// the paper off your ink with no background calibration and no reject radius.
//
//   • Re-tapping is instant. Ownership is recomputed every frame from the
//     current taps; the clusters themselves never need re-seeding.
//   • A bad tap can't poison a cluster, because a tap no longer moves anything.
//
// k-means runs over a HISTOGRAM of the cube, not over raw pixels: ~few thousand
// populated cells instead of 77k pixels, each weighted by its population. Same
// answer, an order of magnitude less work.
//
// The only classical CV in the module is connected-component labelling, used
// for exactly one job: throwing away specks. Every surviving component is
// kept, never just the biggest — disconnected regions, holes, counters and
// interlocks are the point.

import { params, N } from './config.js';
import { labCube, cubeIndex, CUBE, dE2, rgb2lab } from './lab.js';

const NO_CLASS = 255;

// ── constants (deliberately not sliders) ──────────────────────────────────────

// How many clusters to discover. Needs to comfortably exceed the number of inks
// so there's always somewhere for paper, shadow, glare and skin to go. Too few
// and an unmodelled colour gets forced into an ink's cluster — the exact failure
// we're fixing. Too many just costs a little time; spare clusters harmlessly
// split the background. 10 is generous for any small-palette design.
const K = 10;

// How fast a centre chases its cluster's weighted mean. Ink doesn't move;
// lighting drifts slowly; sensor noise is fast. Low and steady.
const CENTRE_EMA = 0.2;

// Confidence ramps over this fraction of the distance to the nearest cluster
// belonging to a DIFFERENT owner. Scale-free — it means the same thing whether
// the palette is three garish inks or two nearly identical blues.
const SOFT_FRAC = 0.35;

// Temporal smoothing on the per-owner membership fields. Boundary pixels flip
// class under sensor noise; smoothing the alpha kills the crawl at its source.
const ALPHA_EMA = 0.45;

// A cluster holding less than this share of the frame is dead, and gets
// re-seeded onto whatever the frame is currently modelling worst.
const DEAD_FRAC = 0.0005;

// Clusters closer than this (ΔE) are the same ink, and get merged into one
// GROUP before ownership is decided.
//
// This matters more than it looks. K is deliberately larger than the number of
// real inks (so there's always somewhere for paper and shadow to go), which
// means k-means will happily spend its spare centres SPLITTING a real ink into
// two or three sub-clusters — same colour, a few ΔE apart, separated only by
// sensor noise. If a tap then claimed a single cluster, it would claim one
// shard of its own ink and abandon the rest: the region would come out riddled
// with holes. (First run of this code: the light ink recovered 2482 of its 5500
// pixels. That's why.)
//
// So: merge, then claim. 8 ΔE comfortably swallows noise-induced splits while
// staying well clear of any real palette separation — the two Ey Es blues are
// 27 apart, white-to-light-blue is 17.
const MERGE_DE = 8;

// ── state ─────────────────────────────────────────────────────────────────────

const hist = new Uint32Array(CUBE);        // cube cell → pixel count this frame
const cellOwner = new Uint8Array(CUBE);    // cube cell → owning palette idx / NO_CLASS
const cellConf = new Uint8Array(CUBE);     // cube cell → 0-255 soft membership

let cL = new Float32Array(K), cA = new Float32Array(K), cB = new Float32Array(K);
let ready = false;

// clusterOwner[k] = palette index that claimed cluster k, or -1 (background)
let clusterOwner = new Int8Array(K).fill(-1);

let pxClass = null;       // Uint8Array(n): per-pixel owning palette idx / NO_CLASS
let pxConf  = null;       // Uint8Array(n): per-pixel 0-255 soft membership
let alpha   = [];         // Float32Array(n) per palette slot: EMA'd 0-1 field

let labels, labelStack;   // connected-component scratch
let hard;                 // Uint8 thresholded mask, reused per class
let rgba;                 // shared proc-res RGBA stencil handed to render.js

let lastPalette = [];     // classifyFrame's palette, kept for pieceAtPixel

export function resetClusters() { ready = false; }

// One allocator for everything, sized to the proc resolution. Membership
// fields are per-palette-slot, and there can never be more slots than pieces —
// so the count is just N.
export function allocBuffers(w, h) {
  const n = w * h;
  pxClass = new Uint8Array(n);
  pxConf  = new Uint8Array(n);
  alpha = Array.from({ length: N }, () => new Float32Array(n));
  labels = new Int32Array(n);
  labelStack = new Int32Array(n);
  hard = new Uint8Array(n);
  rgba = new Uint8ClampedArray(n * 4);
}

// ── palette ───────────────────────────────────────────────────────────────────
// One entry per calibrated slot. The stored RGB is used ONLY to decide which
// discovered cluster this entry claims — it is never itself a match target, and
// nothing drifts it. A calibration record is exactly { r, g, b }: what
// calibrate.js samples, what configIO.js saves and loads.
function buildPalette(calibrated) {
  const palette = [];
  for (let i = 0; i < calibrated.length; i++) {
    const c = calibrated[i];
    if (!c) continue;
    const [L, a, bb] = rgb2lab(c.r, c.g, c.b);
    palette.push({ pi: i, r: c.r, g: c.g, b: c.b, L, a: a, b: bb });
  }
  return palette;
}

// ── init: k-means++ over the histogram ────────────────────────────────────────
// Pick the first centre from the frame's most populous colour, then repeatedly
// pick the cell that is furthest from every centre chosen so far, weighted by
// how many pixels sit there. That spreads the initial centres across the actual
// inks instead of clumping them all in the paper (which, on a print, is most of
// the frame). Standard k-means++, just weighted by the histogram.
function initCentres(cells) {
  let bestCell = cells[0], bestPop = 0;
  for (const cell of cells) {
    if (hist[cell] > bestPop) { bestPop = hist[cell]; bestCell = cell; }
  }
  let li = bestCell * 3;
  cL[0] = labCube[li]; cA[0] = labCube[li + 1]; cB[0] = labCube[li + 2];

  for (let k = 1; k < K; k++) {
    let bestScore = -1, pick = bestCell;
    for (const cell of cells) {
      const i3 = cell * 3;
      const L = labCube[i3], a = labCube[i3 + 1], b = labCube[i3 + 2];
      let dmin = Infinity;
      for (let j = 0; j < k; j++) {
        const d = dE2(L, a, b, cL[j], cA[j], cB[j]);
        if (d < dmin) dmin = d;
      }
      const score = dmin * hist[cell];   // far AND populous
      if (score > bestScore) { bestScore = score; pick = cell; }
    }
    const p3 = pick * 3;
    cL[k] = labCube[p3]; cA[k] = labCube[p3 + 1]; cB[k] = labCube[p3 + 2];
  }
  ready = true;
}

// ── ownership: which tap claims which GROUP of clusters ───────────────────────
// Two steps.
//
// 1. MERGE. Union-find over clusters closer than MERGE_DE: shards of the same
//    ink collapse into one group. Without this, a tap claims one shard and the
//    rest of its own colour reads as background.
//
// 2. CLAIM. Each tap claims exactly one GROUP — the one nearest to it — greedily,
//    closest pair first, no group serving two taps. Every group nobody points at
//    is background: it competes for its own pixels, keeps the paper off your ink,
//    and draws nothing.
//
// Note there's no radius test on the claim, and that's deliberate. A tap that
// lands on an ink is always nearest to that ink's own group, so a threshold
// could only ever create a way for a legitimate tap to claim nothing. Paper
// stays unclaimed not because it's far, but because nobody pointed at it.
const parent = new Int8Array(K);
function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }

function assignOwners(palette) {
  // 1. merge
  for (let j = 0; j < K; j++) parent[j] = j;
  for (let i = 0; i < K; i++) {
    for (let j = i + 1; j < K; j++) {
      if (dE2(cL[i], cA[i], cB[i], cL[j], cA[j], cB[j]) < MERGE_DE * MERGE_DE) {
        const a = find(i), b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }

  // group representative → its members' weighted-ish centre is just the rep's
  // own centre; shards are within MERGE_DE by construction, so any member is a
  // fine stand-in for the group's colour.
  const roots = [];
  for (let j = 0; j < K; j++) if (find(j) === j) roots.push(j);

  // 2. claim
  clusterOwner.fill(-1);
  const groupOwner = new Map();   // root → palette index
  const usedRoot = new Set();
  const usedP = new Uint8Array(palette.length);
  const steps = Math.min(roots.length, palette.length);

  for (let s = 0; s < steps; s++) {
    let best = null;
    for (let p = 0; p < palette.length; p++) {
      if (usedP[p]) continue;
      for (const r of roots) {
        if (usedRoot.has(r)) continue;
        const d = dE2(palette[p].L, palette[p].a, palette[p].b, cL[r], cA[r], cB[r]);
        if (!best || d < best.d) best = { p, r, d };
      }
    }
    if (!best) break;
    groupOwner.set(best.r, best.p);
    usedRoot.add(best.r); usedP[best.p] = 1;
  }

  for (let j = 0; j < K; j++) {
    const r = find(j);
    clusterOwner[j] = groupOwner.has(r) ? groupOwner.get(r) : -1;
  }
}

// ── the frame pass ────────────────────────────────────────────────────────────
function quantizeFrame(img, palette, w, h) {
  const n = w * h;
  const k = palette.length;
  if (!k || !pxClass || pxClass.length !== n) return;

  // 1. histogram the frame over the colour cube
  hist.fill(0);
  const cells = [];
  for (let p = 0, q = 0; p < n; p++, q += 4) {
    const cell = cubeIndex(img[q], img[q + 1], img[q + 2]);
    if (hist[cell]++ === 0) cells.push(cell);
  }
  if (!cells.length) return;

  if (!ready) initCentres(cells);

  // 2. who owns what, from the current taps
  assignOwners(palette);

  // 3. assign every POPULATED cell to its nearest cluster, and in the same pass
  //    accumulate the weighted means for the k-means update. Only populated
  //    cells are touched — typically a few thousand, not all 32768, and never
  //    the 77k pixels themselves.
  const sL = new Float64Array(K), sA = new Float64Array(K), sB = new Float64Array(K);
  const wt = new Float64Array(K);

  let worstCell = cells[0], worstScore = -1;

  for (const cell of cells) {
    const i3 = cell * 3;
    const L = labCube[i3], a = labCube[i3 + 1], b = labCube[i3 + 2];

    // nearest cluster overall
    let d1 = Infinity, k1 = 0;
    for (let j = 0; j < K; j++) {
      const d = dE2(L, a, b, cL[j], cA[j], cB[j]);
      if (d < d1) { d1 = d; k1 = j; }
    }

    const owner = clusterOwner[k1];
    const wgt = hist[cell];

    sL[k1] += L * wgt; sA[k1] += a * wgt; sB[k1] += b * wgt; wt[k1] += wgt;

    // track the frame's worst-modelled populous colour, for re-seeding a dead
    // cluster onto it below
    const score = d1 * wgt;
    if (score > worstScore) { worstScore = score; worstCell = cell; }

    if (owner < 0) { cellOwner[cell] = NO_CLASS; cellConf[cell] = 0; continue; }

    // Nearest cluster with a DIFFERENT owner. This is the key subtlety: the
    // margin must be measured against another OWNER, not merely another
    // cluster. If an ink ever splits across two clusters, the seam between them
    // is internal — it must not produce a soft, faded edge down the middle of a
    // region that is, to the user, a single colour.
    let d2 = Infinity;
    for (let j = 0; j < K; j++) {
      if (clusterOwner[j] === owner) continue;
      const d = dE2(L, a, b, cL[j], cA[j], cB[j]);
      if (d < d2) d2 = d;
    }

    let conf = 255;
    if (Number.isFinite(d2)) {
      const sep = Math.sqrt(d2) - Math.sqrt(d1);
      // ramp scaled to how far this cluster sits from its nearest rival owner
      const ramp = Math.max(1, Math.sqrt(d2) * SOFT_FRAC);
      conf = Math.max(0, Math.min(255, Math.round((sep / ramp) * 255)));
    }
    cellOwner[cell] = owner;
    cellConf[cell] = conf;
  }

  // 4. per-pixel lookup — one array read each
  for (let p = 0, q = 0; p < n; p++, q += 4) {
    const cell = cubeIndex(img[q], img[q + 1], img[q + 2]);
    pxClass[p] = cellOwner[cell];
    pxConf[p] = cellConf[cell];
  }

  // 5. EMA the per-owner membership fields. Done for every owner, not just the
  //    winner, so an owner fades OUT smoothly where it loses ground rather than
  //    snapping to zero.
  for (let c = 0; c < k; c++) {
    const f = alpha[c];
    for (let p = 0; p < n; p++) {
      const target = (pxClass[p] === c) ? pxConf[p] / 255 : 0;
      f[p] += (target - f[p]) * ALPHA_EMA;
    }
  }

  stepCentres(sL, sA, sB, wt, n, worstCell);
}

// One Lloyd update, eased. A starved cluster is re-seeded onto the frame's
// worst-modelled populous colour — which is how a new ink entering the scene
// gets a cluster of its own instead of being swallowed by a neighbour.
function stepCentres(sL, sA, sB, wt, n, worstCell) {
  const dead = n * DEAD_FRAC;
  for (let j = 0; j < K; j++) {
    if (wt[j] < dead) {
      const w3 = worstCell * 3;
      cL[j] = labCube[w3]; cA[j] = labCube[w3 + 1]; cB[j] = labCube[w3 + 2];
      continue;
    }
    const mL = sL[j] / wt[j], mA = sA[j] / wt[j], mB = sB[j] / wt[j];
    cL[j] += (mL - cL[j]) * CENTRE_EMA;
    cA[j] += (mA - cA[j]) * CENTRE_EMA;
    cB[j] += (mB - cB[j]) * CENTRE_EMA;
  }
}

// ── public API ────────────────────────────────────────────────────────────────

// Classify the frame. Call once per frame, before any detectClassStencil.
// Returns the palette, so the caller can map class index → piece index
// (calibrated slots may be sparse, so the two are not the same number).
export function classifyFrame(img, calibrated, w, h) {
  lastPalette = buildPalette(calibrated);
  quantizeFrame(img, lastPalette, w, h);
  return lastPalette;
}

// Which piece owns the pixel at proc-space index `p`, or -1. This is the whole
// of hit-testing (see links.js): the classifier already knows who owns every
// pixel, so asking it is both simpler and more faithful than reconstructing a
// polygon and ray-casting into it.
export function pieceAtPixel(p) {
  if (!pxClass || p < 0 || p >= pxClass.length) return -1;
  const c = pxClass[p];
  if (c === NO_CLASS || c >= lastPalette.length) return -1;
  return lastPalette[c].pi;
}

// Flood-fill `hard`, zeroing every component smaller than minA. 8-connected, so
// a diagonal hairline in the print (the crossbar of that Y) stays whole instead
// of fragmenting into rejected specks.
function rejectSpecks(w, h, minA) {
  const n = w * h;
  labels.fill(0);
  let cur = 0;
  for (let s = 0; s < n; s++) {
    if (!hard[s] || labels[s]) continue;
    cur++;
    let sp = 0, head = 0;
    labelStack[sp++] = s; labels[s] = cur;
    while (sp > head) {
      const idx = labelStack[head++];
      const x = idx % w, y = (idx / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= h) continue;
        const nrow = ny * w;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx; if (nx < 0 || nx >= w) continue;
          const nidx = nrow + nx;
          if (hard[nidx] && !labels[nidx]) { labels[nidx] = cur; labelStack[sp++] = nidx; }
        }
      }
    }
    // labelStack[0..sp) now holds exactly this component's members
    if (sp < minA) for (let m = 0; m < sp; m++) hard[labelStack[m]] = 0;
  }
}

// One colour → one stencil. `c` is a palette index (from classifyFrame).
// Returns { rgba, w, h, bx, by, bw, bh, filled } — the exact shape render.js's
// drawFillOverlay consumes. Null if the colour isn't meaningfully present.
//
// The stencil's alpha is the SMOOTHED membership field, not a hard 0/255 mask.
// That's what gives soft edges where one printed ink meets another, and what
// stops boundary pixels from strobing under sensor noise. The connected-
// component pass only gates WHICH pixels may appear — it never quantises their
// alpha.
export function detectClassStencil(c, w, h) {
  const n = w * h;
  const field = alpha[c];
  if (!field) return null;

  // hard mask for component analysis: "this pixel is more this colour than not"
  for (let p = 0; p < n; p++) hard[p] = field[p] > 0.5 ? 1 : 0;
  rejectSpecks(w, h, params.minArea);

  let minX = w, minY = h, maxX = -1, maxY = -1;
  let filled = 0;

  for (let p = 0, q = 0; p < n; p++, q += 4) {
    if (!hard[p]) { rgba[q + 3] = 0; continue; }
    rgba[q] = 255; rgba[q + 1] = 255; rgba[q + 2] = 255;
    rgba[q + 3] = Math.round(Math.min(1, field[p]) * 255);
    const x = p % w, y = (p / w) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    filled++;
  }

  if (filled < params.minArea) return null;

  return {
    rgba, w, h,
    bx: minX, by: minY, bw: maxX - minX + 1, bh: maxY - minY + 1,
    filled,
  };
}