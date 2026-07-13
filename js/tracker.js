// ── tracker: pixels → per-colour stencils ─────────────────────────────────────
// What used to live here — HSV bands, Moore-neighbour boundary tracing,
// arc-length resampling, largest-blob selection, the MAX_JUMP hand guard — is
// all gone. None of it could express the thing we actually need to track: a
// figure-ground marker whose colours form disconnected, interlocking regions
// with holes. A polygon fundamentally cannot represent that shape; a raster
// stencil trivially can.
//
// So detection now ends where rendering begins: quantize.js assigns every pixel
// to its nearest calibrated colour and maintains a smooth 0-1 membership field
// per colour; this module turns each field into an RGBA stencil that render.js
// composites media through (destination-in). Every pixel of a colour is
// preserved — spirals, counters, interlocks and all.
//
// The only classical CV left is connected-component labelling, and it's used
// for exactly one job: throwing away specks. We keep EVERY surviving component,
// never just the biggest — that's the whole point.

import { params } from './config.js';
import {
  allocQuantBuffers, buildPalette, quantizeFrame, classAlpha, NO_CLASS,
} from './quantize.js';

let labels, labelStack;   // connected-component scratch
let hard;                 // Uint8 thresholded mask, reused per class
let rgba;                 // shared proc-res RGBA stencil handed to render.js

export function allocBuffers(w, h, nClasses = 16) {
  const n = w * h;
  labels = new Int32Array(n);
  labelStack = new Int32Array(n);
  hard = new Uint8Array(n);
  rgba = new Uint8ClampedArray(n * 4);
  allocQuantBuffers(w, h, nClasses);
}

// Classify the frame. Call once per frame, before any detectClassStencil.
// Returns the palette, so the caller can map class index → piece index.
export function classifyFrame(img, calibrated, w, h) {
  const palette = buildPalette(calibrated);
  quantizeFrame(img, palette, w, h);
  return palette;
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
// Returns { rgba, w, h, bx, by, bw, bh, filled, centroid } — the exact shape
// render.js's drawFillOverlay already consumes, plus a centroid for main.js's
// miss/grace bookkeeping. Null if the colour isn't meaningfully present.
//
// The stencil's alpha is the SMOOTHED membership field, not a hard 0/255 mask.
// That's what gives soft edges where one printed ink meets another, and what
// stops boundary pixels from strobing under sensor noise. The connected-
// component pass only gates WHICH pixels may appear — it never quantises their
// alpha.
export function detectClassStencil(c, w, h) {
  const n = w * h;
  const field = classAlpha(c);
  if (!field) return null;

  // hard mask for component analysis: "this pixel is more this colour than not"
  for (let p = 0; p < n; p++) hard[p] = field[p] > 0.5 ? 1 : 0;
  rejectSpecks(w, h, params.minArea);

  let minX = w, minY = h, maxX = -1, maxY = -1;
  let filled = 0, sx = 0, sy = 0;

  for (let p = 0, q = 0; p < n; p++, q += 4) {
    if (!hard[p]) { rgba[q + 3] = 0; continue; }
    rgba[q] = 255; rgba[q + 1] = 255; rgba[q + 2] = 255;
    rgba[q + 3] = Math.round(Math.min(1, field[p]) * 255);
    const x = p % w, y = (p / w) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    sx += x; sy += y; filled++;
  }

  if (filled < params.minArea) return null;

  return {
    rgba, w, h,
    bx: minX, by: minY, bw: maxX - minX + 1, bh: maxY - minY + 1,
    filled,
    centroid: [sx / filled, sy / filled],
  };
}

export { NO_CLASS };