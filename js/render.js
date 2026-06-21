// ── rendering ─────────────────────────────────────────────────────────────────
// Per-piece overlays (media or colour wash, clipped to the polygon) + the debug
// strip. Reads detection results; never mutates them.

import { PIECES, N } from './config.js';
import { hsvToHex } from './hsv.js';
import { state } from './state.js';
import { mainCtx as ctx, debugBar } from './dom.js';
import { pieceMedia } from './media.js';
import { drawCaption } from './caption.js';

function tracePath(hull) {
  ctx.beginPath();
  ctx.moveTo(hull[0][0], hull[0][1]);
  for (let j = 1; j < hull.length; j++) ctx.lineTo(hull[j][0], hull[j][1]);
  ctx.closePath();
}

// Cover-fit `el` into the bbox (centre-cropped), like CSS object-fit: cover.
function drawFitted(el, bx, by, bw, bh) {
  const mw = el.videoWidth || el.naturalWidth || 1;
  const mh = el.videoHeight || el.naturalHeight || 1;
  const s = Math.max(bw / mw, bh / mh), dw = mw * s, dh = mh * s;
  ctx.globalAlpha = 0.92;
  ctx.drawImage(el, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh);
  ctx.globalAlpha = 1;
}

export function drawOverlay(hull, i, MW, MH) {
  if (!hull || hull.length < 3) return;
  const cal = state.calibrated[i];
  const color = hsvToHex(cal.h, cal.s, cal.v);
  const media = pieceMedia[i];

  // bbox of the polygon — shared by media fitting and caption scaling
  const xs = hull.map(p => p[0]), ys = hull.map(p => p[1]);
  const bx = Math.min(...xs), by = Math.min(...ys);
  const bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;

  ctx.save();
  tracePath(hull);
  ctx.clip();

  const showVideo = media && media.type === 'video' && !media.el.paused;
  if (media && (media.type === 'image' || showVideo)) {
    drawFitted(media.el, bx, by, bw, bh);
  } else {
    // colour wash (also the backdrop captions are drawn over)
    ctx.globalAlpha = 0.45; ctx.fillStyle = color; ctx.fillRect(0, 0, MW, MH); ctx.globalAlpha = 1;
    if (media && media.type === 'captions') drawCaption(ctx, media.cues, i, bx, by, bw, bh);
  }
  ctx.restore();

  // outline
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  tracePath(hull);
  ctx.stroke();
  ctx.restore();
}

export function renderDebugBar(counts) {
  let html = '';
  for (let i = 0; i < N; i++) {
    const cal = state.calibrated[i];
    if (!cal) continue;
    const col = hsvToHex(cal.h, cal.s, cal.v);
    html += counts[i] > 0
      ? `<span class="dbadge" style="background:${col}22;color:${col};border:1px solid ${col}88">${PIECES[i].name} ${counts[i]}px</span>`
      : `<span class="dbadge" style="color:#444;border:1px solid #222">${PIECES[i].name} —</span>`;
  }
  debugBar.innerHTML = html;
}