// ── tracker: pixels → polygon ─────────────────────────────────────────────────
// Per-piece detection: calibrated colour → boundary trace → fixed-N polygon.

import { params, CLOSE_R, BOUNDARY_N, MAX_JUMP_FRAC } from './config.js';

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
  // V tolerance is a FLOOR only, not a band. Under blacklight the paint
  // should be the brightest saturated thing in frame, and its absolute
  // brightness legitimately drifts more than ambient-light tracking would
  // (UV intensity falls off with distance/angle, gloss finishes add
  // hotspots) — rejecting pixels for being "too bright" only ever cost real
  // detections as a piece moved further from the light source, it never
  // filtered anything useful.
  const vFloor = cal.v - vT;
  for (let p = 0; p < count; p++) {
    let dh = Math.abs(Hc[p] - cal.h) % 360; if (dh > 180) dh = 360 - dh;
    maskA[p] = (dh <= hT && Math.abs(Sc[p] - cal.s) <= sT && Vc[p] >= vFloor) ? 1 : 0;
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

// Flood-fill label maskA; return EVERY blob at or above minA, each with area,
// centroid, and a seed pixel for traceBoundary (topmost-leftmost pixel of
// that label, always on the outer boundary — see the old largestBlob's note,
// still true per-blob here). Enumerating every candidate, not just the
// biggest, is what lets chooseBlob() prefer "the blob near where this piece
// was last seen" over "whatever's biggest right now" — the latter is exactly
// what let a hand or a stray patch of matching fluorescence hijack tracking.
function findBlobs(w, h, minA) {
  const n = w * h;
  labels.fill(0);
  let cur = 0;
  const blobs = [];
  for (let s = 0; s < n; s++) {
    if (!maskA[s] || labels[s]) continue;
    cur++;
    let sp = 0;
    labelStack[sp++] = s; labels[s] = cur;
    let area = 0, sx = 0, sy = 0;
    while (sp > 0) {
      const idx = labelStack[--sp];
      area++;
      const x = idx % w, y = (idx / w) | 0;
      sx += x; sy += y;
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
    if (area >= minA) blobs.push({ label: cur, area, cx: sx / area, cy: sy / area, start: s });
  }
  return blobs;
}

// Choose which blob is "the piece". With a known previous position
// (prevCentroid, proc-space [x,y]), prefer the LARGEST blob within
// MAX_JUMP_FRAC of the frame width from that position, ignoring anything
// farther away no matter how big — a hand or stray fluorescence winning on
// size alone doesn't matter if it's nowhere near where the piece actually
// was. If nothing qualifies nearby, this frame reads as a miss (returns
// null) rather than snapping to a distant blob; the caller's grace-period
// logic decides whether that's a brief occlusion or a real loss.
// With no previous position (first acquisition, or re-acquiring after a real
// loss), there's nothing to be near, so just take the largest blob overall.
function chooseBlob(blobs, prevCentroid, w) {
  if (!blobs.length) return null;
  if (prevCentroid) {
    const maxJump = w * MAX_JUMP_FRAC;
    let best = null;
    for (const b of blobs) {
      const d = Math.hypot(b.cx - prevCentroid[0], b.cy - prevCentroid[1]);
      if (d <= maxJump && (!best || b.area > best.area)) best = b;
    }
    return best;
  }
  let best = blobs[0];
  for (const b of blobs) if (b.area > best.area) best = b;
  return best;
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

// Resample the trace to n points, evenly spaced by arc length. The trace always
// starts at the blob's topmost-leftmost pixel (see findBlobs), so point index
// is already stable frame to frame without any anchor search — index i means
// "the same point around the perimeter" every frame, which is what lets the
// straight per-index lerp in geometry.js's matchAndLerp be correct.
function resampleByArcLength(trace, n) {
  const m = trace.length;
  if (m < 3) return trace.map(p => p.slice());

  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const a = trace[i], b = trace[(i + 1) % m];
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
    const a = trace[seg], b = trace[(seg + 1) % m];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// Full per-piece pipeline. Returns { poly, filled, centroid } or null.
// computeHSV must have been called for this frame first. `prevCentroid` is
// this piece's last known proc-space position (or null) — see chooseBlob.
export function detectPiece(cal, w, h, prevCentroid) {
  buildMask(cal, w * h);
  morphClose(w, h, CLOSE_R);
  const blobs = findBlobs(w, h, params.minArea);
  const blob = chooseBlob(blobs, prevCentroid, w);
  if (!blob) return null;

  const trace = traceBoundary(blob.label, blob.start, w, h);
  if (trace.length < 3) return null;

  const poly = resampleByArcLength(trace, BOUNDARY_N);
  return { poly, filled: blob.area, centroid: [blob.cx, blob.cy] };
}