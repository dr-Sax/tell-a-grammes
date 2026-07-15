// ── calibrate: tap-to-sample colour calibration + hover readout ───────────────
// A tap now stores an RGB reference triple. That is the whole calibration —
// detection compares pixels to these triples directly (quantize.js), so what
// you sample IS what you match against, with no tolerance bands to tune.
//
// Two changes from the HSV era worth calling out:
//
//   MEDIAN, not mean. Print has specular hotspots and the camera has noise; a
//   mean drags the reference toward whichever glare pixel was brightest. The
//   per-channel median just ignores it. (The old circular-hue mean solved a
//   problem — the 0°/360° seam — that simply doesn't exist in RGB.)
//
//   NO saturation/brightness filter. The old code discarded pixels with
//   s < 0.2 or v < 0.15 to strip the white lightbox out of a border sample.
//   That filter would now reject the two things we most want to calibrate:
//   white and black. Every pixel in the patch votes.
//
import { PIECES } from './config.js';
import { state } from './state.js';
import { mainCanvas, tapHint, crosshair, statusEl, overlayPanel, clientToCanvasPoint } from './dom.js';
import { readCanvas, readCtx, drawOriented, video } from './camera.js';
import { pieceMedia } from './media.js';
import { buildUI } from './ui.js';

function medianOf(arr, n) {
  const s = arr.slice(0, n).sort((a, b) => a - b);
  const m = n >> 1;
  return n % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function calibrateAt(clientX, clientY) {
  if (state.calibrating < 0 || !state.running) return;
  const [px, py] = clientToCanvasPoint(clientX, clientY, readCanvas, { round: true });

  // sample a patch around the tap from the proc-res read canvas
  drawOriented(readCtx, readCanvas.width, readCanvas.height);
  const r = 6;
  const x0 = Math.max(0, px - r), y0 = Math.max(0, py - r);
  const w = Math.min(readCanvas.width  - x0, r * 2);
  const h = Math.min(readCanvas.height - y0, r * 2);
  if (w <= 0 || h <= 0) { statusEl.textContent = 'Tap inside the frame'; return; }
  const data = readCtx.getImageData(x0, y0, w, h).data;

  const n = w * h;
  const rs = new Uint8Array(n), gs = new Uint8Array(n), bs = new Uint8Array(n);
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    rs[i] = data[q]; gs[i] = data[q + 1]; bs[i] = data[q + 2];
  }
  if (n < 4) { statusEl.textContent = 'Tap missed — try again'; return; }

  const R = medianOf(rs, n), G = medianOf(gs, n), B = medianOf(bs, n);
  state.calibrated[state.calibrating] = { r: R, g: G, b: B };
  statusEl.textContent =
    `${PIECES[state.calibrating].name} → RGB(${R}, ${G}, ${B})`;
  state.calibrating = -1;
  tapHint.style.display = 'none';
  crosshair.style.display = 'none';
  if (readout) readout.style.display = 'none';
  overlayPanel.classList.add('open');
  buildUI();
}

// Any tap is a user gesture — use it to make sure the iOS camera stream is
// still playing (it can get suspended mid-session). Runs even while calibrating.
function keepCameraLive() {
  if (video.paused) video.play().catch(() => {});
}

// Small floating readout that tracks the crosshair while calibrating, so you
// can see the live colour under the cursor before you tap. Now shows RGB (what
// is actually stored and matched) rather than HSV.
let readout = null;
function ensureReadout() {
  if (readout) return readout;
  readout = document.createElement('div');
  readout.style.cssText =
    'position:fixed;pointer-events:none;z-index:9999;display:none;' +
    'background:rgba(0,0,0,0.78);color:#fff;font:12px/1.3 monospace;' +
    'padding:3px 7px;border-radius:4px;white-space:nowrap;transform:translate(14px,-28px);';
  document.body.appendChild(readout);
  return readout;
}

function updateReadout(clientX, clientY) {
  const el = ensureReadout();
  const [px, py] = clientToCanvasPoint(clientX, clientY, readCanvas, { round: true });
  if (px < 0 || py < 0 || px >= readCanvas.width || py >= readCanvas.height) {
    el.style.display = 'none';
    return;
  }
  const d = readCtx.getImageData(px, py, 1, 1).data;
  el.textContent = `R${d[0]} G${d[1]} B${d[2]}`;
  el.style.left = clientX + 'px';
  el.style.top  = clientY + 'px';
  el.style.display = 'block';
}

export function wireCalibration() {
  mainCanvas.addEventListener('mousemove', e => {
    if (state.calibrating < 0) return;
    const rect = mainCanvas.getBoundingClientRect();
    crosshair.style.left = (e.clientX - rect.left) + 'px';
    crosshair.style.top  = (e.clientY - rect.top)  + 'px';
    updateReadout(e.clientX, e.clientY);
  });
  mainCanvas.addEventListener('mouseleave', () => {
    if (readout) readout.style.display = 'none';
  });
  mainCanvas.addEventListener('click', e => calibrateAt(e.clientX, e.clientY));
  // touch: tap to calibrate without firing a synthetic mouse scroll
  mainCanvas.addEventListener('touchend', e => {
    keepCameraLive();
    if (state.calibrating < 0) return;
    e.preventDefault();
    const t = e.changedTouches[0];
    if (t) calibrateAt(t.clientX, t.clientY);
  }, { passive: false });
  // keep the camera live + resume any autoplay-blocked piece videos on tap
  mainCanvas.addEventListener('pointerdown', () => {
    keepCameraLive();
    if (state.calibrating >= 0) return;
    for (const m of pieceMedia) if (m && m.type === 'video' && m.el.paused) m.el.play().catch(() => {});
  });
}