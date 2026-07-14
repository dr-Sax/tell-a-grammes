// ── media links: tap-to-open per-piece URLs ────────────────────────────────────
// If a colour's media has a `link` set (independent of the asset's own URL —
// see configIO.js and the ↗ button in ui-media.js), tapping that colour's
// rendered region opens it in a new tab.
//
// Hit-testing used to ray-cast against state.smoothHulls. Those polygons stopped
// existing when detection went raster, and nothing had populated them since — so
// this feature had been silently dead. It now asks the classifier directly: which
// colour owns the pixel under your finger? That's simpler than a polygon test and
// strictly more accurate, because it hit-tests the region actually being drawn,
// holes and counters and all — a tap in the middle of a letter's counter no longer
// registers as a hit on the letter.

import { state } from './state.js';
import { mainCanvas, clientToCanvasPoint } from './dom.js';
import { readCanvas } from './camera.js';
import { pieceAtPixel } from './tracker.js';
import { pieceMedia } from './media.js';

// clientX/clientY (viewport coords) → whether a link was found and opened.
// No-ops while calibrating, so calibration taps are never read as link taps.
function openIfLinked(clientX, clientY) {
  if (state.calibrating >= 0) return false;

  const [x, y] = clientToCanvasPoint(clientX, clientY, readCanvas, { round: true });
  if (x < 0 || y < 0 || x >= readCanvas.width || y >= readCanvas.height) return false;

  const i = pieceAtPixel(y * readCanvas.width + x);
  if (i < 0) return false;

  const link = pieceMedia[i] && pieceMedia[i].link;
  if (!link) return false;

  window.open(link, '_blank', 'noopener');
  return true;
}

export function wireMediaLinks() {
  mainCanvas.addEventListener('click', e => { openIfLinked(e.clientX, e.clientY); });

  // Touch: preventDefault only when a link actually opened, which suppresses the
  // trailing synthetic click. Unrelated taps are left alone.
  mainCanvas.addEventListener('touchend', e => {
    const t = e.changedTouches[0];
    if (!t) return;
    if (openIfLinked(t.clientX, t.clientY)) e.preventDefault();
  }, { passive: false });
}