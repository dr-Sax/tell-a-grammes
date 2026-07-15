// ── runtime state ─────────────────────────────────────────────────────────────
// The single mutable hub for per-session / per-frame state. Mutate its
// properties (never reassign the export) so every importer sees one object.

import {N, MEDIA_SLIDERS} from './config.js';

export const state = {
  running: false,
  calibrating: -1,                  // piece index being calibrated, or -1
  calibrated: Array(N).fill(null),  // per piece: { r, g, b } — the sampled reference triple


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

  // Stereoscopic display: mirrors mainCanvas into a side-by-side double-wide
  // canvas for use with a phone-based stereo viewer. Assumes landscape;
  // no orientation handling is done, by design (keep this simple).
  stereo: false,

  // Stereo eye-convergence adjustment, in degrees. Rotates the left eye by
  // +stereoAngle and the right eye by -stereoAngle (about each half's own
  // center) to correct for viewer/lens misalignment. 0 = no adjustment.
  stereoAngle: 0,

  // Per-eye horizontal crop-position correction, as a fraction of frame width.
  // Compensates for the physical camera lens being offset from the phone's
  // center — that offset reads as a horizontal shift once the same source
  // frame is duplicated into a stereo pair, and flips sign when the phone is
  // rotated to the other landscape orientation.
  stereoShiftL: 0,
  stereoShiftR: 0,
  stereoDistort: 0,   // barrel coefficient: 0 = flat, + = barrel, − = pincushion
  stereoFill: 1,   // >1 zooms each eye to push barrel corners toward the edges
};