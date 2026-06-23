// ── calibration: colour sampling + save/load ──────────────────────────────────
// Tap-to-sample a piece's border colour, and persist/restore the full setup.

import { PIECES, N, params } from './config.js';
import { state } from './state.js';
import { rgb2hsv } from './hsv.js';
import { mainCanvas, tapHint, crosshair, statusEl, $ } from './dom.js';
import { readCanvas, readCtx, drawOriented, video } from './camera.js';
import { pieceMedia } from './media.js';
import { buildUI, syncSliders } from './ui.js';

function calibrateAt(clientX, clientY) {
  if (state.calibrating < 0 || !state.running) return;
  const rect = mainCanvas.getBoundingClientRect();
  const scaleX = readCanvas.width  / rect.width;
  const scaleY = readCanvas.height / rect.height;
  const px = Math.round((clientX - rect.left) * scaleX);
  const py = Math.round((clientY - rect.top)  * scaleY);

  // sample a patch around the tap from the proc-res read canvas
  drawOriented(readCtx, readCanvas.width, readCanvas.height);
  const r = 6;
  const x0 = Math.max(0, px - r), y0 = Math.max(0, py - r);
  const w = Math.min(readCanvas.width  - x0, r * 2);
  const h = Math.min(readCanvas.height - y0, r * 2);
  if (w <= 0 || h <= 0) { statusEl.textContent = 'Tap inside the frame'; return; }
  const data = readCtx.getImageData(x0, y0, w, h).data;

  // average only saturated/bright pixels — discards the white lightbox and the
  // dark hole, leaving the border colour. Calibrate with the feed off (white).
  let hs = 0, ss = 0, vs = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [hh, s, v] = rgb2hsv(data[i], data[i + 1], data[i + 2]);
    if (s > 0.2 && v > 0.15) { hs += hh; ss += s; vs += v; n++; }
  }
  if (n < 4) { statusEl.textContent = 'Tap missed — too dark or unsaturated, try again'; return; }

  const cal = { h: hs / n, s: ss / n, v: vs / n };
  state.calibrated[state.calibrating] = cal;
  state.smoothHulls[state.calibrating] = null;
  statusEl.textContent =
    `${PIECES[state.calibrating].name} → H=${Math.round(cal.h)}° S=${cal.s.toFixed(2)} V=${cal.v.toFixed(2)}`;
  state.calibrating = -1;
  tapHint.style.display = 'none';
  crosshair.style.display = 'none';
  buildUI();
}

// Any tap is a user gesture — use it to make sure the iOS camera stream is
// still playing (it can get suspended mid-session). Runs even while calibrating.
function keepCameraLive() {
  if (video.paused) video.play().catch(() => {});
}

export function wireCalibration() {
  mainCanvas.addEventListener('mousemove', e => {
    if (state.calibrating < 0) return;
    const rect = mainCanvas.getBoundingClientRect();
    crosshair.style.left = (e.clientX - rect.left) + 'px';
    crosshair.style.top  = (e.clientY - rect.top)  + 'px';
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

// ── save / load ───────────────────────────────────────────────────────────────
function getCalData() {
  return {
    htol: params.htol, stol: params.stol, vtol: params.vtol, minArea: params.minArea,
    pieces: state.calibrated.map((c, i) => c ? { ...c, name: PIECES[i].name } : null),
  };
}

function applyCalData(data) {
  for (const key of ['htol', 'stol', 'vtol', 'minArea'])
    if (data[key] !== undefined) params[key] = data[key];
  syncSliders();
  if (Array.isArray(data.pieces)) {
    data.pieces.forEach((c, i) => {
      state.calibrated[i] = c ? { h: c.h, s: c.s, v: c.v } : null;
      state.smoothHulls[i] = null;
    });
  }
  buildUI();
}

export function wireSaveLoad() {
  $('saveBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(getCalData(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'tangram-calibration.json'; a.click();
    URL.revokeObjectURL(url);
    $('calName').textContent = 'saved ✓';
  };
  $('loadBtn').onclick = () => $('loadFile').click();
  $('loadFile').onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        applyCalData(JSON.parse(ev.target.result));
        $('calName').textContent = `loaded: ${file.name}`;
        statusEl.textContent = 'Calibration loaded — start camera to begin tracking';
      } catch (err) {
        statusEl.textContent = 'Failed to parse calibration file';
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };
  $('clearAllBtn').onclick = () => {
    if (!confirm('Clear all calibrations?')) return;
    state.calibrated = Array(N).fill(null);
    state.smoothHulls = Array(N).fill(null);
    $('calName').textContent = '';
    buildUI();
  };
}