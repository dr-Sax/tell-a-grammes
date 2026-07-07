// ── rendering ─────────────────────────────────────────────────────────────────
// Draws the per-piece overlays (media clipped to the polygon, or a colour wash)
// and the debug strip. Reads detection results; never mutates them.

import { PIECES, N } from './config.js';
import { hsvToHex } from './hsv.js';
import { state } from './state.js';
import { mainCtx, debugBar } from './dom.js';
import { pieceMedia } from './media.js';
import { drawCaption } from './caption.js';
import { poolAsset } from './pool.js';
import { timelineValueAt } from './timeline.js';

export function drawOverlay(hull, i, MW, MH) {
  if (!hull || hull.length < 3) return;
  const cal = state.calibrated[i];
  const color = hsvToHex(cal.h, cal.s, cal.v);

  // polygon bounding box — used by both the image fit and the caption layout
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
  const adj = state.mediaAdjust[i];

  // The element to actually draw this frame, or null → colour wash. Image/gif
  // use the piece's own decoded asset; a video only while it's playing; a
  // sequence resolves its timeline (keyed off the shared captionElapsed[i]
  // clock, so it pauses when the piece leaves frame just like a caption) to an
  // index into the global pool, and draws whatever asset sits there — null if
  // that slot is empty or failed to decode, which falls through to the wash.
  // Captions never set this: they wash, then paint a word on top below.
  let frameEl = null;
  if (media) {
    if (media.type === 'image' || media.type === 'gif') frameEl = media.el;
    else if (media.type === 'video' && !media.el.paused) frameEl = media.el;
    else if (media.type === 'sequence') {
      const asset = poolAsset(timelineValueAt(media.cues, state.captionElapsed[i]));
      if (asset) frameEl = asset.el;
    }
  }

  if (frameEl) {
    const mw = frameEl.videoWidth  || frameEl.naturalWidth  || frameEl.width  || 1;
    const mh = frameEl.videoHeight || frameEl.naturalHeight || frameEl.height || 1;
    const scale = Math.max(bw / mw, bh / mh) * adj.zoom;
    const dw = mw * scale, dh = mh * scale;
    const cx = bx + bw / 2 + adj.xshift * bw;
    const cy = by + bh / 2 + adj.yshift * bh;
    mainCtx.globalAlpha = 0.92;
    mainCtx.translate(cx, cy);
    mainCtx.rotate(adj.rotate * Math.PI / 180);
    mainCtx.drawImage(frameEl, -dw / 2, -dh / 2, dw, dh);
  } else {
    mainCtx.globalAlpha = 0.45;
    mainCtx.fillStyle = color;
    mainCtx.fillRect(0, 0, MW, MH);
    mainCtx.globalAlpha = 1;
  }

  // caption word on top of the wash, still inside the polygon clip. The active
  // word is keyed off state.captionElapsed[i] (advanced in main.js only on
  // detected frames), so a piece's captions pause when it leaves frame.
  if (media && media.type === 'caption') {
    drawCaption(mainCtx, media.cues, i, bx, by, bw, bh, adj);
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