// ── media links: tap-to-open per-piece URLs ────────────────────────────────────
// If a piece's media has a `link` set (independent of the media asset's own
// URL — see calibration.js's getCalData/applyCalData, and the ↗ link button
// in ui.js), tapping/clicking that piece's rendered overlay opens it in a new
// tab. Hit-testing uses the same smoothed hulls render.js draws from, so
// "tap the piece" means the same thing here as it visually looks like.

import { state } from './state.js';
import { N } from './config.js';
import { mainCanvas } from './dom.js';
import { pieceMedia } from './media.js';
import { pointInPolygon } from './geometry.js';

// Which piece (if any) contains this canvas-space point. Checked in reverse
// draw order — later-index pieces are drawn on top in main.js's loop, so on
// the rare occasion two pieces' hulls overlap on screen, the visually topmost
// one should be the one that "catches" the tap.
function hitPiece(x, y) {
  for (let i = N - 1; i >= 0; i--) {
    const hull = state.smoothHulls[i];
    if (hull && pointInPolygon([x, y], hull)) return i;
  }
  return -1;
}

// clientX/clientY (viewport coords, e.g. from a click/touch event) → whether
// a link was found and opened at that point. Returns false (no-op) while
// calibrating, so calibration taps are never mistaken for link taps.
function openIfLinked(clientX, clientY) {
  if (state.calibrating >= 0) return false;
  const rect = mainCanvas.getBoundingClientRect();
  const scaleX = mainCanvas.width / rect.width;
  const scaleY = mainCanvas.height / rect.height;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;

  const i = hitPiece(x, y);
  if (i < 0) return false;
  const link = pieceMedia[i] && pieceMedia[i].link;
  if (!link) return false;

  window.open(link, '_blank', 'noopener');
  return true;
}

export function wireMediaLinks() {
  // Desktop / mouse.
  mainCanvas.addEventListener('click', e => { openIfLinked(e.clientX, e.clientY); });

  // Touch: handled on touchend (matches calibration.js's own tap handling),
  // and preventDefault only when a link actually opened — that suppresses
  // the trailing synthetic click a touchend normally generates, so the link
  // doesn't fire twice. Left alone (no preventDefault) when nothing was hit,
  // so unrelated taps behave exactly as they did before this module existed.
  mainCanvas.addEventListener('touchend', e => {
    const t = e.changedTouches[0];
    if (!t) return;
    if (openIfLinked(t.clientX, t.clientY)) e.preventDefault();
  }, { passive: false });
}