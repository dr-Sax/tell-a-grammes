// ── rendering ─────────────────────────────────────────────────────────────────
// Draws the per-piece overlays (media clipped to the polygon, or a colour wash)
// and the debug strip. Reads detection results; never mutates them.

import { PIECES, N, CAPTION } from './config.js';
import { hsvToHex } from './hsv.js';
import { state } from './state.js';
import { mainCtx, debugBar } from './dom.js';
import { pieceMedia, activeCaption } from './media.js';

export function drawOverlay(hull, i, MW, MH) {
  if (!hull || hull.length < 3) return;
  const cal = state.calibrated[i];
  const color = hsvToHex(cal.h, cal.s, cal.v);

  // Bounding box of the piece polygon. Computed once and shared by image/video
  // fitting and caption scaling (the brief: reuse this box, don't recompute).
  const xs = hull.map(p => p[0]), ys = hull.map(p => p[1]);
  const bx = Math.min(...xs), by = Math.min(...ys);
  const bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;

  // clip to the piece polygon
  mainCtx.save();
  mainCtx.beginPath();
  mainCtx.moveTo(hull[0][0], hull[0][1]);
  for (let j = 1; j < hull.length; j++) mainCtx.lineTo(hull[j][0], hull[j][1]);
  mainCtx.closePath();
  mainCtx.clip();

  const media = pieceMedia[i];
  const showVideo = media && media.type === 'video' && !media.el.paused;

  if (media && (media.type === 'image' || showVideo)) {
    const mw = media.el.videoWidth  || media.el.naturalWidth  || 1;
    const mh = media.el.videoHeight || media.el.naturalHeight || 1;
    const scale = Math.max(bw / mw, bh / mh);
    const dw = mw * scale, dh = mh * scale;
    const dx = bx + (bw - dw) / 2, dy = by + (bh - dh) / 2;
    mainCtx.globalAlpha = 0.92;
    mainCtx.drawImage(media.el, dx, dy, dw, dh);
    mainCtx.globalAlpha = 1;
  } else if (media && media.type === 'captions') {
    // Colour wash so the word is legible whether the feed is on or off, then
    // the currently-active word centred + scaled into the bounding box.
    mainCtx.globalAlpha = CAPTION.washAlpha;
    mainCtx.fillStyle = color;
    mainCtx.fillRect(0, 0, MW, MH);
    mainCtx.globalAlpha = 1;
    const word = activeCaption(media, state.captionElapsed[i]);
    if (word) drawCaption(word, bx, by, bw, bh);
  } else {
    mainCtx.globalAlpha = 0.45;
    mainCtx.fillStyle = color;
    mainCtx.fillRect(0, 0, MW, MH);
    mainCtx.globalAlpha = 1;
  }
  mainCtx.restore();

  // outline
  mainCtx.save();
  mainCtx.strokeStyle = color;
  mainCtx.lineWidth = 2;
  mainCtx.beginPath();
  mainCtx.moveTo(hull[0][0], hull[0][1]);
  for (let j = 1; j < hull.length; j++) mainCtx.lineTo(hull[j][0], hull[j][1]);
  mainCtx.closePath();
  mainCtx.stroke();
  mainCtx.restore();
}

// Centre `word` in the bbox, scaled to fill CAPTION.widthFrac of the width but
// never taller than CAPTION.heightFrac of the height. Single line, no wrap
// (cue values are single words / short phrases by design). The caller has
// already clipped to the piece polygon, so anything spilling past the polygon
// edge is trimmed naturally.
function drawCaption(word, bx, by, bw, bh) {
  const cx = bx + bw / 2, cy = by + bh / 2;
  const base = 100;  // measure once at a fixed size, then scale the result
  mainCtx.font = `${CAPTION.fontWeight} ${base}px ${CAPTION.fontFamily}`;
  const textW = mainCtx.measureText(word).width || 1;
  const byWidth  = (bw * CAPTION.widthFrac)  / textW;
  const byHeight = (bh * CAPTION.heightFrac) / base;
  const px = Math.max(CAPTION.minPx, base * Math.min(byWidth, byHeight));

  mainCtx.font = `${CAPTION.fontWeight} ${px}px ${CAPTION.fontFamily}`;
  mainCtx.textAlign = 'center';
  mainCtx.textBaseline = 'middle';
  mainCtx.lineJoin = 'round';
  mainCtx.lineWidth = Math.max(2, px * CAPTION.strokeFrac);
  mainCtx.strokeStyle = CAPTION.stroke;
  mainCtx.strokeText(word, cx, cy);
  mainCtx.fillStyle = CAPTION.fill;
  mainCtx.fillText(word, cx, cy);
}

export function renderDebugBar(counts) {
  let html = '';
  for (let i = 0; i < N; i++) {
    const cal = state.calibrated[i];
    if (!cal) continue;
    const c = counts[i];
    const col = hsvToHex(cal.h, cal.s, cal.v);
    html += c > 0
      ? `<span class="dbadge" style="background:${col}22;color:${col};border:1px solid ${col}88">${PIECES[i].name} ${c}px</span>`
      : `<span class="dbadge" style="color:#444;border:1px solid #222">${PIECES[i].name} —</span>`;
  }
  debugBar.innerHTML = html;
}