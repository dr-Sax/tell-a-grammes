// ── tracker: pixels → polygon ─────────────────────────────────────────────────
// The detection engine. Owns the per-frame typed-array buffers and turns one
// calibrated colour into a fixed-N boundary polygon. Pieces are detected
// independently — there is no cross-piece pixel claiming.
//
// Detection no longer tries to find "the k true corners" of a shape. Instead it
// walks the blob's actual outer perimeter pixel-by-pixel (Moore-neighbor
// tracing) and resamples that trace down to a fixed BOUNDARY_N points, evenly
// spaced by arc length. This sidesteps corner-identification entirely — no
// shape-specific fitting, no greedy area-maximization that can tie/collapse
// corners (the square-collapsing-to-a-triangle bug). The resulting polygon is
// good enough for clip-path / canvas-clip overlay rendering without needing
// pixel-exact corners.

import { params, CLOSE_R, BOUNDARY_N } from './config.js';

// per-frame work buffers (allocated once proc dimensions are known)
let Hc, Sc, Vc;            // per-pixel HSV (Float32: H 0-360, S/V 0-1)
let maskA, maskB, maskC;   // binary scratch masks (Uint8)
let labels, labelStack;    // connected-component labels + flood-fill stack
let visited;               // boundary-trace visited flag (Uint8), safety net only

export function allocBuffers(w, h) {
  const n = w * h;
  Hc = new Float32Array(n); Sc = new Float32Array(n); Vc = new Float32Array(n);
  maskA = new Uint8Array(n); maskB = new Uint8Array(n); maskC = new Uint8Array(n);
  labels = new Int32Array(n); labelStack = new Int32Array(n);
  visited = new Uint8Array(n);
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

// Moore-neighbor 8-direction offsets, in a fixed rotational order (CCW).
// Index meanings: 0=E,1=NE,2=N,3=NW,4=W,5=SW,6=S,7=SE
const MOORE_DX = [ 1, 1, 0,-1,-1,-1, 0, 1];
const MOORE_DY = [ 0,-1,-1,-1, 0, 1, 1, 1];

// Trace the outer boundary of `label` starting from `startIdx` (which must be
// a labeled pixel already known to sit on the boundary — see findStart below).
// Returns an ordered list of [x,y] boundary pixels, walking once around.
// Standard Moore-neighbor tracing: from the direction we *arrived* from, scan
// the 8 neighbors in rotational order starting just past that direction, and
// step to the first labeled one found. This hugs the outer edge and never
// crosses into the unlabeled hole (the hole is never labeled, so it's simply
// invisible to this walk — same hole-ignoring guarantee as before, just now
// via the walk itself rather than via row/column extents).
function traceBoundary(label, startIdx, w, h) {
  const pts = [];
  const maxSteps = w * h * 2; // generous safety cap; real boundaries are O(perimeter)

  let idx = startIdx;
  let x = idx % w, y = (idx / w) | 0;
  // arrive-direction: pretend we arrived from the west, so the first scan
  // begins at N — irrelevant for correctness, just a fixed convention.
  let arriveDir = 4;
  const startX = x, startY = y;

  for (let step = 0; step < maxSteps; step++) {
    pts.push([x, y]);

    // scan starting just after the reverse of the direction we arrived from
    const scanStart = (arriveDir + 5) % 8; // (arriveDir+4)%8 = back-direction; +1 to start past it
    let found = false;
    for (let k = 0; k < 8; k++) {
      const dir = (scanStart + k) % 8;
      const nx = x + MOORE_DX[dir], ny = y + MOORE_DY[dir];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      if (labels[ny * w + nx] === label) {
        x = nx; y = ny; arriveDir = dir; found = true;
        break;
      }
    }
    if (!found) break; // isolated single pixel — nothing else to walk to
    if (x === startX && y === startY && step > 0) break; // back to start
  }
  return pts;
}

// Find a pixel on the outer boundary of `label` to start tracing from.
// Scanning row-major and taking the first labeled pixel found is guaranteed
// to be a boundary pixel: nothing above it or to its left (within the raster
// scan order) is labeled, so it necessarily has an unlabeled/edge neighbor.
function findStart(label, w, h) {
  const n = w * h;
  for (let s = 0; s < n; s++) {
    if (labels[s] === label) return s;
  }
  return -1;
}

// Resample an ordered boundary trace to exactly `n` points, evenly spaced by
// arc length, starting as close as possible to `anchorXY` (previous frame's
// start point in the same proc-pixel space) so point index stays stable
// frame-to-frame even though the raw trace's point count/order varies.
function resampleByArcLength(trace, n, anchorXY) {
  const m = trace.length;
  if (m === 0) return null;
  if (m < 3) return trace.map(p => p.slice()); // degenerate, nothing to resample

  // rotate the trace array so it starts at the point nearest the anchor
  let startI = 0;
  if (anchorXY) {
    let bestD = Infinity;
    for (let i = 0; i < m; i++) {
      const dx = trace[i][0] - anchorXY[0], dy = trace[i][1] - anchorXY[1];
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; startI = i; }
    }
  }

  // cumulative arc length, starting at startI, wrapping once around
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const a = trace[(startI + i) % m];
    const b = trace[(startI + i + 1) % m];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    cum[i + 1] = cum[i] + Math.sqrt(dx * dx + dy * dy);
  }
  const total = cum[m];
  if (total <= 0) return trace.map(p => p.slice());

  const out = [];
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / n;
    while (seg < m - 1 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const t = segLen > 0 ? (target - cum[seg]) / segLen : 0;
    const a = trace[(startI + seg) % m];
    const b = trace[(startI + seg + 1) % m];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// Full per-piece pipeline. `cal` = calibrated HSV, w×h = proc dims, `anchorXY`
// = previous frame's boundary[0] in proc px (or null on first detection).
// Returns { poly:[[x,y]…BOUNDARY_N] in proc px, filled, anchorXY } or null.
// computeHSV must have been called for this frame first.
export function detectPiece(cal, w, h, anchorXY) {
  buildMask(cal, w * h);
  morphClose(w, h, CLOSE_R);
  const blob = largestBlob(w, h, params.minArea);
  if (!blob) return null;

  const startIdx = findStart(blob.label, w, h);
  if (startIdx < 0) return null;
  const trace = traceBoundary(blob.label, startIdx, w, h);
  if (trace.length < 3) return null;

  const poly = resampleByArcLength(trace, BOUNDARY_N, anchorXY);
  if (!poly) return null;

  return { poly, filled: blob.area, anchorXY: poly[0] };
}