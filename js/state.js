// ── runtime state ─────────────────────────────────────────────────────────────
// The single mutable hub for per-session / per-frame state. Mutate its
// properties (never reassign the export) so every importer sees one object.

import { N } from './config.js';

export const state = {
  running: false,
  calibrating: -1,                  // piece index being calibrated, or -1
  calibrated: Array(N).fill(null),  // per piece: { h:0-360, s:0-1, v:0-1 }
  smoothHulls: Array(N).fill(null), // smoothed boundary polygon per piece, canvas px
  smoothArea: Array(N).fill(0),     // running mean filled area, proc px
  boundaryAnchor: Array(N).fill(null), // per piece: [x,y] in proc px — previous
                                        // frame's resample start point, so the
                                        // fixed-N boundary polygon's point order
                                        // stays stable frame to frame (see
                                        // tracker.js resampleByArcLength)

  // view / orientation for the landscape-TV rig
  rotation: 0,        // 0 | 90 | 180 | 270
  mirror: false,      // horizontal flip
  showFeed: true,     // camera feed vs. white lightbox behind overlays
};