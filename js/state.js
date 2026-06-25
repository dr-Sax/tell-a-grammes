// ── runtime state ─────────────────────────────────────────────────────────────
// The single mutable hub for per-session / per-frame state. Mutate its
// properties (never reassign the export) so every importer sees one object.

import {N, MEDIA_SLIDERS} from './config.js';

export const state = {
  running: false,
  calibrating: -1,                  // piece index being calibrated, or -1
  calibrated: Array(N).fill(null),  // per piece: { h:0-360, s:0-1, v:0-1 }
  smoothHulls: Array(N).fill(null), // smoothed polygon per piece, canvas px
  smoothArea: Array(N).fill(0),     // running mean filled area, proc px

  // Per-piece caption clock. This is "elapsed seconds while this piece was
  // detected" — it advances only on frames where the piece is found, and is
  // left untouched (not reset, not advanced) on dropout frames. The active
  // word is looked up against this counter, never wall-clock time. See
  // main.js for the advance and media.js for the cue lookup.
  captionElapsed: Array(N).fill(0),

  // Per-piece media framing. One independent object per piece (built from
  // MEDIA_SLIDERS defaults). Mutated in place by the ui sliders; read fresh by
  // render.js each frame, which is what makes the sliders feel real-time.
  mediaAdjust: Array.from({ length: N }, () =>
    Object.fromEntries(MEDIA_SLIDERS.map(s => [s.key, s.def]))),

  lastFrameTime: 0,  // previous frame's rAF timestamp (ms) for delta-time

  showFeed: true,     // camera feed vs. white lightbox behind overlays
};