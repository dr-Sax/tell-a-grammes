// ── tracker: pixels → polygon ─────────────────────────────────────────────────
// Per-piece detection: calibrated colour → boundary trace → fixed-N polygon.
// Also hosts auto-calibration (dominant-colour extraction) since it reads the
// same HSV buffers.

import { params, CLOSE_R, BOUNDARY_N } from './config.js';
import { hueDiff360 } from './hsv.js';

let Hc, Sc, Vc;            // per-pixel HSV (Float32: H 0-360, S/V 0-1)
let maskA, maskB, maskC;   // binary scratch masks (Uint8)
let labels, labelStack;    // connected-component labels + flood-fill stack

const SMOOTH_ITERS = 1;    // 3-point outline smoothing passes (0 = off)

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
  // Hue is the discriminating, lighting-stable channel, so it stays a tight
  // symmetric gate. Saturation and value drift with surface shading and gloss,
  // so they are one-sided FLOORS, not symmetric windows: any pixel of the right
  // hue that's at least roughly as saturated and bright as the calibrated sample
  // counts. This captures vivid highlights, the mid-tone, and shaded regions as
  // one piece — a fuller, less flickery ring — while the floors still reject the
  // white background (low S) and the dark hole (low V). Raising the S/V sliders
  // lowers the floors (more tolerance); the upper side is intentionally open.
  const sFloor = cal.s - sT, vFloor = cal.v - vT;
  for (let p = 0; p < count; p++) {
    let dh = Math.abs(Hc[p] - cal.h) % 360; if (dh > 180) dh = 360 - dh;
    maskA[p] = (dh <= hT && Sc[p] >= sFloor && Vc[p] >= vFloor) ? 1 : 0;
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

// Flood-fill label maskA; return { label, area, start } for the largest blob
// over minA. `start` is the blob's seed pixel — the first pixel of that label
// hit in row-major order, i.e. its topmost-leftmost pixel, which is always on
// the outer boundary and is therefore a valid traceBoundary start.
function largestBlob(w, h, minA) {
  const n = w * h;
  labels.fill(0);
  let cur = 0, bestLabel = 0, bestArea = minA, bestStart = -1;
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
    if (area > bestArea) { bestArea = area; bestLabel = cur; bestStart = s; }
  }
  return bestLabel ? { label: bestLabel, area: bestArea, start: bestStart } : null;
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
// starts at the blob's topmost-leftmost pixel (see largestBlob), so point index
// is already stable frame to frame without any anchor search.
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

// Light spatial smoothing of the closed outline: a 3-point circular moving
// average that rounds off the single-pixel jaggies left by the integer Moore
// trace. Index-stable resampling means neighbours are adjacent perimeter points,
// so this is just (prev+cur+next)/3 around the loop. matchAndLerp (in main.js)
// smooths across frames; this smooths within a frame — together they calm the
// overlay far more than either alone.
function smoothClosed(pts, iters) {
  let cur = pts;
  for (let it = 0; it < iters; it++) {
    const n = cur.length, out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n], b = cur[i], c = cur[(i + 1) % n];
      out[i] = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    }
    cur = out;
  }
  return cur;
}

// Full per-piece pipeline. Returns { poly, filled } or null.
// computeHSV must have been called for this frame first.
export function detectPiece(cal, w, h) {
  buildMask(cal, w * h);
  morphClose(w, h, CLOSE_R);
  const blob = largestBlob(w, h, params.minArea);
  if (!blob) return null;

  const trace = traceBoundary(blob.label, blob.start, w, h);
  if (trace.length < 3) return null;

  const poly = smoothClosed(resampleByArcLength(trace, BOUNDARY_N), SMOOTH_ITERS);
  return { poly, filled: blob.area };
}

// ── auto-calibration: dominant border colours from the HSV buffer ─────────────
// Assumes computeHSV ran for the current frame. With the feed OFF (white
// lightbox) the only saturated pixels are the piece borders, so a saturation-
// weighted hue histogram is effectively a histogram of border colours. Returns
// up to k {h,s,v} sorted by hue; fewer if there aren't k distinct colours.
const AC_MIN_S = 0.2;   // ignore the white background / desaturated noise
const AC_MIN_V = 0.15;  // ignore the dark holes
const AC_BINS  = 90;    // hue histogram resolution (4° per bin)

export function detectDominantColors(w, h, k) {
  const count = w * h;
  const binW = 360 / AC_BINS;

  // saturation-weighted hue histogram over qualifying pixels
  const hist = new Float32Array(AC_BINS);
  let total = 0;
  for (let p = 0; p < count; p++) {
    const s = Sc[p];
    if (s < AC_MIN_S || Vc[p] < AC_MIN_V) continue;
    let b = (Hc[p] / binW) | 0; if (b >= AC_BINS) b = AC_BINS - 1;
    hist[b] += s; total += s;
  }
  if (total <= 0) return [];

  // circular box-blur (radius 1) so one colour spread across adjacent bins
  // reads as a single peak
  const sm = new Float32Array(AC_BINS);
  for (let i = 0; i < AC_BINS; i++)
    sm[i] = hist[(i - 1 + AC_BINS) % AC_BINS] + hist[i] + hist[(i + 1) % AC_BINS];

  // peak-find by non-max suppression. A peak must clear a small share of total
  // weight (rejects glare specks); suppress a ±(htol·2)° window around each so
  // the next peak is a genuinely different colour (same threshold the conflict
  // warning and detection use).
  const floor = total * 0.02;
  const supBins = Math.max(1, Math.round((params.htol * 2) / binW));
  const work = sm.slice();
  const peakBins = [];
  for (let n = 0; n < k; n++) {
    let bi = -1, bv = floor;
    for (let i = 0; i < AC_BINS; i++) if (work[i] > bv) { bv = work[i]; bi = i; }
    if (bi < 0) break;
    peakBins.push(bi);
    for (let d = -supBins; d <= supBins; d++) work[(bi + d + AC_BINS) % AC_BINS] = 0;
  }

  // refine each peak to a real {h,s,v}: circular (vector) mean of the pixels
  // within the hue window, so a window straddling 0°/360° averages correctly.
  const win = params.htol * 2;
  const out = [];
  for (const bi of peakBins) {
    const peakHue = (bi + 0.5) * binW;
    let sumSin = 0, sumCos = 0, sumS = 0, sumV = 0, nn = 0;
    for (let p = 0; p < count; p++) {
      const s = Sc[p], v = Vc[p];
      if (s < AC_MIN_S || v < AC_MIN_V) continue;
      if (hueDiff360(Hc[p], peakHue) > win) continue;
      const rad = Hc[p] * Math.PI / 180;
      sumSin += Math.sin(rad) * s; sumCos += Math.cos(rad) * s;
      sumS += s; sumV += v; nn++;
    }
    if (nn < 4) continue;
    let hue = Math.atan2(sumSin, sumCos) * 180 / Math.PI;
    if (hue < 0) hue += 360;
    out.push({ h: hue, s: sumS / nn, v: sumV / nn });
  }
  out.sort((a, b) => a.h - b.h);
  return out;
}