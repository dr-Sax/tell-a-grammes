// ── captions: timed-word overlays ─────────────────────────────────────────────
// The third per-piece media type. Everything caption-specific lives here:
// parse the cue file, look up the active word against a piece's "detected-time"
// clock (state.captionElapsed[i]), and draw it. The clock is *advanced* in
// main.js — only on frames where the piece is detected — and reset on attach in
// media.js; this module just reads it.

import { state } from './state.js';

const WIDTH_FRAC  = 0.50;  // word fills this fraction of the bbox width…
const HEIGHT_FRAC = 0.50;  // …but is never taller than this fraction of it
const FONT = px => `700 ${px}px system-ui, sans-serif`;

// {"<seconds>": "<word>"} → time-sorted [{ t, text }]. JSON key order isn't
// guaranteed, so the sort is required, not cosmetic.
export function parseCues(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.keys(raw)
    .map(k => ({ t: parseFloat(k), text: String(raw[k]) }))
    .filter(c => Number.isFinite(c.t))
    .sort((a, b) => a.t - b.t);
}

// Last cue with t <= elapsed (binary search). null before the first cue; the
// final word holds forever — there are no end times, by design.
export function captionWord(cues, elapsed) {
  let lo = 0, hi = cues.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].t <= elapsed) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans < 0 ? null : cues[ans].text;
}

// Draw piece i's active word into its bounding box, centred + scaled to fit a
// single line. `ctx` is already clipped to the piece polygon and the colour
// wash already painted by the caller.
export function drawCaption(ctx, cues, i, bx, by, bw, bh) {
  const word = captionWord(cues, state.captionElapsed[i]);
  if (!word) return;

  ctx.font = FONT(100);                       // measure at a fixed size, scale result
  const tw = ctx.measureText(word).width || 1;
  const px = Math.max(8, 100 * Math.min(bw * WIDTH_FRAC / tw, bh * HEIGHT_FRAC / 100));

  ctx.font = FONT(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, px * 0.08);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';        // outline so it reads on feed or white
  ctx.strokeText(word, bx + bw / 2, by + bh / 2);
  ctx.fillStyle = '#fff';
  ctx.fillText(word, bx + bw / 2, by + bh / 2);
}

// "CC" badge data URL for the media-row thumbnail (captions have no frame).
export function captionThumbURL() {
  const c = document.createElement('canvas');
  c.width = 40; c.height = 28;
  const g = c.getContext('2d');
  g.fillStyle = '#16202e'; g.fillRect(0, 0, 40, 28);
  g.fillStyle = '#7ab8f5'; g.font = FONT(13);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('CC', 20, 15);
  return c.toDataURL();
}