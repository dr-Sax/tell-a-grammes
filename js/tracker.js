// ── tracker: pixels → polygon ─────────────────────────────────────────────────
// Per-piece detection: calibrated colour → boundary trace → fixed-N polygon.

import { params, CLOSE_R, BOUNDARY_N } from './config.js';

let Hc, Sc, Vc;            // per-pixel HSV (Float32: H 0-360, S/V 0-1)
let maskA, maskB, maskC;   // binary scratch masks (Uint8)
let labels, labelStack;    // connected-component labels + flood-fill stack

export function allocBuffers(w, h) {
  const n = w * h;
  Hc = new Float32Array(n); Sc = new Float32Array(n); Vc = new Float32Array(n);
  maskA = new Uint8Array(n); maskB = new Uint8Array(n); maskC = new Uint8Array(n);
  labels = new Int32Array(n); labelStack = new Int32Array(n);
}

// RGB→HSV for the whole frame, once.
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
    Hc[p] = h; Sc[p] = max > 0 ? d / max : 0; Vc[p] = max;
  }
}

function buildMask(cal, count) {
  const hT = params.htol * 2, sT = params.stol / 255, vT = params.vtol / 255;
  for (let p = 0; p < count; p++) {
    let dh = Math.abs(Hc[p] - cal.h) % 360; if (dh > 180) dh = 360 - dh;
    maskA[p] = (dh <= hT && Math.abs(Sc[p] - cal.s) <= sT && Math.abs(Vc[p] - cal.v) <= vT) ? 1 : 0;
  }
}

// separable binary morphology: horiz pass into tmp, vert pass into dst.
// erode = AND over the window, dilate = OR.
function morphPass(src, dst, tmp, w, h, r, erode) {
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      let acc = erode ? 1 : 0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, v = (xx < 0 || xx >= w) ? 0 : src[off + xx];
        if (erode) { if (!v) { acc = 0; break; } } else { if (v) { acc = 1; break; } }
      }
      tmp[off + x] = acc;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = erode ? 1 : 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy, v = (yy < 0 || yy >= h) ? 0 : tmp[yy * w + x];
        if (erode) { if (!v) { acc = 0; break; } } else { if (v) { acc = 1; break; } }
      }
      dst[y * w + x] = acc;
    }
  }
}

// close = dilate then erode, in place on maskA (maskB/maskC are scratch)
function morphClose(w, h, r) {
  if (r <= 0) return;
  morphPass(maskA, maskB, maskC, w, h, r, false);
  morphPass(maskB, maskA, maskC, w, h, r, true);
}

// flood-fill label maskA; return { label, area } for the largest blob over minA
function largestBlob(w, h, minA) {
  const n = w * h;
  labels.fill(0);
  let cur = 0, bestLabel = 0, bestArea = minA;
  for (let s = 0; s < n; s++) {
    if (!maskA[s] || labels[s]) continue;
    cur++;
    let sp = 0;
    labelStack[sp++] = s; labels[s] = cur;
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

// Moore-neighbor offsets, CCW starting East. Tracing the outer boundary this
// way naturally skips the hole (it's never labeled, so it's just invisible).
const MOORE_DX = [ 1, 1, 0,-1,-1,-1, 0, 1];
const MOORE_DY = [ 0,-1,-1,-1, 0, 1, 1, 1];

function traceBoundary(label, startIdx, w, h) {
  const pts = [];
  const maxSteps = w * h * 2;
  let x = startIdx % w, y = (startIdx / w) | 0, arriveDir = 4;
  const startX = x, startY = y;
  for (let step = 0; step < maxSteps; step++) {
    pts.push([x, y]);
    const scanStart = (arriveDir + 5) % 8;
    let found = false;
    for (let k = 0; k < 8; k++) {
      const dir = (scanStart + k) % 8;
      const nx = x + MOORE_DX[dir], ny = y + MOORE_DY[dir];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      if (labels[ny * w + nx] === label) { x = nx; y = ny; arriveDir = dir; found = true; break; }
    }
    if (!found) break;
    if (x === startX && y === startY && step > 0) break;
  }
  return pts;
}

function findStart(label, w, h) {
  for (let s = 0, n = w * h; s < n; s++) if (labels[s] === label) return s;
  return -1;
}

// Resample the trace to n points, evenly spaced by arc length, starting near
// `anchorXY` (last frame's point 0) so point index stays stable frame to
// frame even as raw trace length varies.
function resampleByArcLength(trace, n, anchorXY) {
  const m = trace.length;
  if (m < 3) return trace.map(p => p.slice());

  let startI = 0;
  if (anchorXY) {
    let bestD = Infinity;
    for (let i = 0; i < m; i++) {
      const dx = trace[i][0] - anchorXY[0], dy = trace[i][1] - anchorXY[1], d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; startI = i; }
    }
  }

  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const a = trace[(startI + i) % m], b = trace[(startI + i + 1) % m];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
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
    const a = trace[(startI + seg) % m], b = trace[(startI + seg + 1) % m];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// Full per-piece pipeline. Returns { poly, filled, anchorXY } or null.
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
  return { poly, filled: blob.area, anchorXY: poly[0] };
}