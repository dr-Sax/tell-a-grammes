// ── captions: timed-word overlays ─────────────────────────────────────────────
// The third per-piece media type. Everything caption-specific lives here:
// parse the cue file, look up the active word against the piece's clock
// (pieceClock in audio.js: the global audio master clock while it plays,
// otherwise this piece's detected-time clock, advanced in main.js only on
// frames where the piece is detected and reset on attach in media.js), and
// draw it. This module only reads the clock.

import { parseTimeline, timelineValueAt } from './timeline.js';
import { pieceClock } from './audio.js';

const WIDTH_FRAC  = 0.50;  // word fills this fraction of the bbox width…
const HEIGHT_FRAC = 0.50;  // …but is never taller than this fraction of it
const FONT = px => `700 ${px}px system-ui, sans-serif`;

// {"<seconds>": "<word>"} → time-sorted [{ t, value }] where value is the word.
// Just the generic timeline parser with the raw values coerced to strings; the
// scheduling itself (sort, hold-until-next, loop) now lives in timeline.js and
// is shared with sequence pieces. Kept exported under this name because media.js
// still imports parseCues for the caption file-picker path.
export const parseCues = raw => parseTimeline(raw, v => String(v));

// Draw piece i's active word into its bounding box, centred + scaled to fit a
// single line. `ctx` is already clipped to the piece polygon and the colour
// wash already painted by the caller.
export function drawCaption(ctx, cues, i, bx, by, bw, bh, adj = { zoom: 1, xshift: 0, yshift: 0, rotate: 0 }) {
  const clock = pieceClock(i);
  const word = timelineValueAt(cues, clock.t, clock.wrap);
  if (!word) return;

  ctx.font = FONT(100);                       // measure at a fixed size, scale result
  const tw = ctx.measureText(word).width || 1;
  const px = Math.max(8, 100 * Math.min(bw * WIDTH_FRAC / tw, bh * HEIGHT_FRAC / 100) * adj.zoom);

  const cx = bx + bw / 2 + adj.xshift * bw;
  const cy = by + bh / 2 + adj.yshift * bh;

  ctx.font = FONT(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, px * 0.08);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.fillStyle = '#fff';

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((adj.rotate || 0) * Math.PI / 180);
  ctx.strokeText(word, 0, 0);                  // origin draw → pivots about its own centre
  ctx.fillText(word, 0, 0);
  ctx.restore();
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