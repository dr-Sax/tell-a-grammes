// ── rendering ─────────────────────────────────────────────────────────────────
// Pours each colour's media through that colour's stencil, and draws the debug
// strip. Reads detection results; never mutates them.

import { PIECES, N } from './config.js';
import { swatchColor } from './color.js';
import { state } from './state.js';
import { mainCtx, debugBar } from './dom.js';
import { pieceMedia } from './media.js';
import { drawCaption } from './caption.js';
import { poolAsset } from './pool.js';
import { timelineValueAt } from './timeline.js';

// ── colour-fill overlay ───────────────────────────────────────────────────────
// Renders a piece as "media poured into every pixel of its colour" rather than
// a tracked polygon — so spirals, interlocking shapes, and holes all work. Uses
// the colour mask (proc-res RGBA stencil from tracker.detectFillMask) as a
// per-pixel stencil via a destination-in composite, which is the raster
// equivalent of a polygon clip — except a stencil can express holes, counters
// and disconnected regions, which is exactly why the polygon path is gone.

let fillCanvas, fillCtx, maskCanvas, maskCtx;
function ensureFillCanvases(PW, PH, MW, MH) {
  if (!fillCanvas) {
    fillCanvas = document.createElement('canvas');
    fillCtx = fillCanvas.getContext('2d');
    maskCanvas = document.createElement('canvas');
    maskCtx = maskCanvas.getContext('2d');
  }
  if (fillCanvas.width !== MW || fillCanvas.height !== MH) {
    fillCanvas.width = MW; fillCanvas.height = MH;
  }
  if (maskCanvas.width !== PW || maskCanvas.height !== PH) {
    maskCanvas.width = PW; maskCanvas.height = PH;
  }
}

// Paint this piece's current media (or colour wash + caption) into `ctx`,
// fit to the given bbox. Masking is the caller's job: drawFillOverlay composites
// the colour's stencil over the result afterward, via destination-in.
function paintMedia(ctx, i, bx, by, bw, bh, MW, MH) {
  const cal = state.calibrated[i];
  const color = swatchColor(cal);
  const media = pieceMedia[i];
  const adj = state.mediaAdjust[i];

  // Clock: state.captionElapsed[i] — "seconds while this colour was visible",
  // advanced in main.js only on frames where the colour was actually found.
  //
  // This function previously reached for a global audio master clock via
  // audioActive() / getAudioTime(), but neither was ever imported into this
  // file — so the first fill draw threw a ReferenceError, which skipped the
  // requestAnimationFrame at the bottom of the frame loop and froze the feed on
  // frame one. It presented as a mobile bug only because the desktop path
  // happened to be exercising the polygon renderer instead.
  //
  // Re-threading the global audio master clock is a separate change.
  const clock = state.captionElapsed[i];

  let frameEl = null;
  if (media) {
    if (media.type === 'image' || media.type === 'gif') frameEl = media.el;
    else if (media.type === 'video' && !media.el.paused) frameEl = media.el;
    else if (media.type === 'sequence') {
      const asset = poolAsset(timelineValueAt(media.cues, clock));
      if (asset) frameEl = asset.el;
    }
  }

  if (frameEl) {
    const mw = frameEl.videoWidth || frameEl.naturalWidth || frameEl.width || 1;
    const mh = frameEl.videoHeight || frameEl.naturalHeight || frameEl.height || 1;
    const scale = Math.max(bw / mw, bh / mh) * adj.zoom;
    const dw = mw * scale, dh = mh * scale;
    const cx = bx + bw / 2 + adj.xshift * bw;
    const cy = by + bh / 2 + adj.yshift * bh;
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.translate(cx, cy);
    ctx.rotate(adj.rotate * Math.PI / 180);
    ctx.drawImage(frameEl, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, MW, MH);
    ctx.restore();
  }

  // drawCaption resolves the active cue from state.captionElapsed[i] itself, so
  // it takes the piece index, not a time.
  if (media && media.type === 'caption') {
    drawCaption(ctx, media.cues, i, bx, by, bw, bh, adj);
  }
}

// res = { rgba, w:PW, h:PH, bx, by, bw, bh, filled } from detectFillMask.
export function drawFillOverlay(i, res, PW, PH, MW, MH) {
  ensureFillCanvases(PW, PH, MW, MH);

  // proc-res stencil → maskCanvas (1:1, no scaling here)
  maskCtx.putImageData(new ImageData(res.rgba, PW, PH), 0, 0);

  // bbox proc→canvas for media framing
  const sx = MW / PW, sy = MH / PH;
  const bx = res.bx * sx, by = res.by * sy, bw = res.bw * sx, bh = res.bh * sy;

  fillCtx.save();
  fillCtx.setTransform(1, 0, 0, 1, 0, 0);
  fillCtx.clearRect(0, 0, MW, MH);
  fillCtx.globalCompositeOperation = 'source-over';
  paintMedia(fillCtx, i, bx, by, bw, bh, MW, MH);
  // keep media only where the colour actually is (upscaled stencil, smoothed
  // for soft edges rather than blocky proc-res steps)
  fillCtx.globalCompositeOperation = 'destination-in';
  fillCtx.imageSmoothingEnabled = true;
  fillCtx.drawImage(maskCanvas, 0, 0, PW, PH, 0, 0, MW, MH);
  fillCtx.restore();

  mainCtx.drawImage(fillCanvas, 0, 0);
}

export function renderDebugBar(counts) {
  let html = '';
  for (let i = 0; i < N; i++) {
    const cal = state.calibrated[i];
    if (!cal) continue;
    const c = counts[i];
    const col = swatchColor(cal);
    html += c > 0
      ? `<span class="dbadge" style="background:${col}22;color:${col};border:1px solid ${col}88">${PIECES[i].name} ${c}px</span>`
      : `<span class="dbadge" style="color:#444;border:1px solid #222">${PIECES[i].name} —</span>`;
  }
  debugBar.innerHTML = html;
}