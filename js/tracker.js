// ── tracker: pixels → polygon ─────────────────────────────────────────────────
// The detection engine. Owns the per-frame typed-array buffers and turns one
// calibrated colour into a fitted polygon. Pieces are detected independently —
// there is no cross-piece pixel claiming.

import { params, CLOSE_R } from './config.js';
import { convexHull, kgonFromHull } from './geometry.js';

// per-frame work buffers (allocated once proc dimensions are known)
let Hc, Sc, Vc;            // per-pixel HSV (Float32: H 0-360, S/V 0-1)
let maskA, maskB, maskC;   // binary scratch masks (Uint8)
let labels, labelStack;    // connected-component labels + flood-fill stack
let silMinX, silMaxX;      // per-row silhouette extents for the winning blob
let silMinY, silMaxY;      // per-column silhouette extents for the winning blob

export function allocBuffers(w, h) {
  const n = w * h;
  Hc = new Float32Array(n); Sc = new Float32Array(n); Vc = new Float32Array(n);
  maskA = new Uint8Array(n); maskB = new Uint8Array(n); maskC = new Uint8Array(n);
  labels = new Int32Array(n); labelStack = new Int32Array(n);
  silMinX = new Int32Array(h); silMaxX = new Int32Array(h);
  silMinY = new Int32Array(w); silMaxY = new Int32Array(w);
}

// RGB→HSV for the whole frame, once. (Inlined for speed; see hsv.js note.)
export function computeHSV(img, count) {
  for (let p = 0, q = 0; p < count; p++, q += 4) {
    const r = img[q] / 255, g = img[q + 1] / 255, b = img[q + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 0) {
      if      (max === r) h = ((g - b) / d + 6) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else                h = (r - g) / d + 4;
      h *= 60;
    }
    Hc[p] = h;
    Sc[p] = max > 0 ? d / max : 0;
    Vc[p] = max;
  }
}

// binary mask of pixels matching `cal`, into maskA
function buildMask(cal, count) {
  const ch = cal.h, cs = cal.s, cvv = cal.v;
  const hT = params.htol * 2;     // degrees
  const sT = params.stol / 255;   // fraction
  const vT = params.vtol / 255;   // fraction
  for (let p = 0; p < count; p++) {
    let dh = Math.abs(Hc[p] - ch) % 360; if (dh > 180) dh = 360 - dh;
    maskA[p] = (dh <= hT &&
                Math.abs(Sc[p] - cs) <= sT &&
                Math.abs(Vc[p] - cvv) <= vT) ? 1 : 0;
  }
}

// separable binary morphology. horiz pass into tmp, vert pass into dst.
// erode = AND over the window, dilate = OR.
function morphPass(src, dst, tmp, w, h, r, erode) {
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      let acc = erode ? 1 : 0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        const v = (xx < 0 || xx >= w) ? 0 : src[off + xx];
        if (erode) { if (!v) { acc = 0; break; } }
        else       { if (v)  { acc = 1; break; } }
      }
      tmp[off + x] = acc;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = erode ? 1 : 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        const v = (yy < 0 || yy >= h) ? 0 : tmp[yy * w + x];
        if (erode) { if (!v) { acc = 0; break; } }
        else       { if (v)  { acc = 1; break; } }
      }
      dst[y * w + x] = acc;
    }
  }
}

// close = dilate then erode, in place on maskA (maskB/maskC are scratch)
function morphClose(w, h, r) {
  if (r <= 0) return;
  morphPass(maskA, maskB, maskC, w, h, r, false);  // dilate → maskB
  morphPass(maskB, maskA, maskC, w, h, r, true);   // erode  → maskA
}

// flood-fill label maskA; return { label, area } for the largest blob over minA
function largestBlob(w, h, minA) {
  const n = w * h;
  labels.fill(0);
  let cur = 0, bestLabel = 0, bestArea = minA;   // strictly greater than minA
  for (let s = 0; s < n; s++) {
    if (!maskA[s] || labels[s]) continue;
    cur++;
    let sp = 0;
    labelStack[sp++] = s;
    labels[s] = cur;
    let area = 0;
    while (sp > 0) {
      const idx = labelStack[--sp];
      area++;
      const x = idx % w, y = (idx / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= h) continue;
        const nrow = ny * w;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx; if (nx < 0 || nx >= w) continue;
          const nidx = nrow + nx;
          if (maskA[nidx] && !labels[nidx]) { labels[nidx] = cur; labelStack[sp++] = nidx; }
        }
      }
    }
    if (area > bestArea) { bestArea = area; bestLabel = cur; }
  }
  return bestLabel ? { label: bestLabel, area: bestArea } : null;
}

// For the winning ring: per-row outer extents AND per-column outer extents
// together give full coverage of the outer silhouette regardless of edge
// orientation. Row-extent alone loses resolution on edges that run shallow
// relative to scanlines (e.g. a parallelogram's long sides, or a square near
// 45°) — those rows are dominated by the near-horizontal edges and tell you
// almost nothing about where the acute-angle corners actually sit. Column
// extents recover exactly that missing signal, and vice versa for near-
// vertical edges, so the two passes are complementary by construction.
//
// The hole sits strictly between the outer crossings in both row and column
// scans (it's unlabeled background, sandwiched between two labeled boundary
// hits), so it's ignored automatically in both passes — same guarantee as
// before, just now holds in both directions.
//
// `filled` (the solid-equivalent area used by the stability guard upstream)
// is still derived purely from the row pass — that's a correct area estimate
// on its own and doesn't need the column data.
function silhouette(label, w, h) {
  for (let y = 0; y < h; y++) { silMinX[y] = 1e9; silMaxX[y] = -1; }
  for (let x = 0; x < w; x++) { silMinY[x] = 1e9; silMaxY[x] = -1; }

  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      if (labels[off + x] === label) {
        if (x < silMinX[y]) silMinX[y] = x;
        if (x > silMaxX[y]) silMaxX[y] = x;
        if (y < silMinY[x]) silMinY[x] = y;
        if (y > silMaxY[x]) silMaxY[x] = y;
      }
    }
  }

  const pts = [];
  let filled = 0;

  // row-extent points (also doubles as the area estimate)
  for (let y = 0; y < h; y++) {
    if (silMaxX[y] < 0) continue;
    filled += silMaxX[y] - silMinX[y] + 1;
    pts.push([silMinX[y], y]);
    if (silMaxX[y] !== silMinX[y]) pts.push([silMaxX[y], y]);
  }

  // column-extent points (no area contribution — row pass already covers that)
  for (let x = 0; x < w; x++) {
    if (silMaxY[x] < 0) continue;
    pts.push([x, silMinY[x]]);
    if (silMaxY[x] !== silMinY[x]) pts.push([x, silMaxY[x]]);
  }

  return { pts, filled };
}

// Full per-piece pipeline. `cal` = calibrated HSV, `k` = corner count, w×h =
// proc dims. Returns { poly:[[x,y]…k] in proc px, filled } or null. computeHSV
// must have been called for this frame first.
export function detectPiece(cal, k, w, h) {
  buildMask(cal, w * h);
  morphClose(w, h, CLOSE_R);
  const blob = largestBlob(w, h, params.minArea);
  if (!blob) return null;
  const { pts, filled } = silhouette(blob.label, w, h);
  const poly = kgonFromHull(convexHull(pts), k);
  return { poly, filled };
}