// ── main: orchestration + frame loop ──────────────────────────────────────────
// Entry point. Wires the modules together and runs the per-frame pipeline.

import { PIECES, N, LERP, MISS_GRACE_FRAMES } from './config.js';
import { state } from './state.js';
import { matchAndLerp } from './geometry.js';
import {
  mainCanvas, mainCtx, statusEl, cvStatusEl, startBtn, controlsEl, calControls,
  panelToggle, overlayPanel, stereoCanvas,
} from './dom.js';
import { readCanvas, readCtx, drawOriented, startCamera } from './camera.js';
import { computeHSV, detectPiece, detectAllPieces, detectFillMask } from './tracker.js';
import { resetTheta, getTheta } from './match.js';
import { drawOverlay, renderDebugBar, drawFillOverlay } from './render.js';
import { buildUI, syncSliders, wireSliders, wireViewControls, wireStereoSlider } from './ui.js';
import { wireCalibration } from './calibrate.js';
import { wireSaveLoad, loadConfigFromURL } from './configIO.js';
import { wireMediaLinks } from './links.js';
import { renderStereoGL } from './stereoGL.js';

// Registration (relative-colour) tracking vs. the original per-piece absolute
// thresholding. Off by default; enable with ?match=1 in the URL (works on iOS
// where there's no keyboard) or toggle live with the M key while running. On
// toggle we drop the session hue-rotation so the new mode re-acquires cleanly.
let matchMode = new URLSearchParams(location.search).get('match') === '1';
window.addEventListener('keydown', e => {
  if (e.key === 'm' || e.key === 'M') {
    matchMode = !matchMode;
    resetTheta();
    statusEl.textContent =
      'Tracking: ' + (matchMode ? 'relative registration (match)' : 'per-piece thresholds');
  }
});

// Colour-fill render mode. Off by default; enable with ?fill=1 or toggle with
// the F key. When on, each calibrated colour is rendered as media poured into
// EVERY pixel of that colour (spirals, interlocking regions, holes) instead of
// one tracked polygon. Detection for the blob/registration paths is untouched —
// this only swaps what gets drawn — so it can't break existing tracking.
let fillMode = new URLSearchParams(location.search).get('fill') === '1';
window.addEventListener('keydown', e => {
  if (e.key === 'f' || e.key === 'F') {
    fillMode = !fillMode;
    statusEl.textContent = 'Render: ' + (fillMode ? 'colour-fill (all regions)' : 'blob polygons');
  }
});

function processFrame(now) {
  if (!state.running) return;
  const t = (typeof now === 'number') ? now : performance.now();
  const dt = state.lastFrameTime ? Math.min(0.25, (t - state.lastFrameTime) / 1000) : 0;
  state.lastFrameTime = t;

  const PW = readCanvas.width, PH = readCanvas.height;
  const MW = mainCanvas.width, MH = mainCanvas.height;
  const scaleX = MW / PW, scaleY = MH / PH;

  drawOriented(readCtx, PW, PH);
  computeHSV(readCtx.getImageData(0, 0, PW, PH).data, PW * PH);

  if (state.showFeed) drawOriented(mainCtx, MW, MH);
  else { mainCtx.fillStyle = '#fff'; mainCtx.fillRect(0, 0, MW, MH); }

  const counts = Array(N).fill(0);

  if (fillMode) {
    // Colour-fill: media poured into every pixel of each calibrated colour. If
    // match mode is also on, run the registration pass once purely to keep θ
    // current, then thread it through detectFillMask so filled colours ride the
    // same lighting compensation as tracked pieces.
    let theta = 0;
    if (matchMode) {
      detectAllPieces(state.calibrated, PW, PH, state.lastCentroid);
      theta = getTheta() || 0;
    }
    for (let i = 0; i < N; i++) {
      const cal = state.calibrated[i];
      if (!cal) continue;
      const res = detectFillMask(cal, PW, PH, theta);
      if (!res) continue;
      state.captionElapsed[i] += dt;
      counts[i] = res.filled;
      drawFillOverlay(i, res, PW, PH, MW, MH);
    }
  } else {

  // In match mode, one segmentation resolves every piece at once; otherwise
  // each piece runs its own absolute-colour detector. Both yield the same
  // per-piece { poly, filled, centroid } | null, so the loop below is identical.
  const batch = matchMode
    ? detectAllPieces(state.calibrated, PW, PH, state.lastCentroid)
    : null;

  for (let i = 0; i < N; i++) {
    const cal = state.calibrated[i];
    if (!cal) continue;

    const found = batch ? batch[i] : detectPiece(cal, PW, PH, state.lastCentroid[i]);

    if (!found) {
      state.missStreak[i]++;
      if (state.missStreak[i] > MISS_GRACE_FRAMES) {
        state.smoothHulls[i] = null;
        state.smoothArea[i] = 0;
        state.lastCentroid[i] = null;
      } else if (state.smoothHulls[i]) {
        drawOverlay(state.smoothHulls[i], i, MW, MH);
      }
      continue;
    }


    state.missStreak[i] = 0;
    state.lastCentroid[i] = found.centroid;
    state.captionElapsed[i] += dt;

    counts[i] = found.filled;
    const poly = found.poly.map(p => [p[0] * scaleX, p[1] * scaleY]);

    const prevA = state.smoothArea[i];
    let lerpThis = LERP;
    if (state.smoothHulls[i] && prevA > 0) {
      const ratio = found.filled / prevA;
      if (ratio < 0.6 || ratio > 1.7) lerpThis = LERP * 0.15;
    }
    state.smoothArea[i] = prevA > 0 ? prevA + (found.filled - prevA) * 0.25 : found.filled;

    state.smoothHulls[i] = matchAndLerp(state.smoothHulls[i], poly, lerpThis);
    drawOverlay(state.smoothHulls[i], i, MW, MH);
  }

  }
  renderDebugBar(counts);

  if (state.stereo) {
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(stereoCanvas.clientWidth  * dpr);
    const ch = Math.round(stereoCanvas.clientHeight * dpr);
    if (cw && ch && (stereoCanvas.width !== cw || stereoCanvas.height !== ch)) {
      stereoCanvas.width = cw; stereoCanvas.height = ch;
    }
    const eyeW = Math.floor(stereoCanvas.width / 2), eyeH = stereoCanvas.height;
    renderStereoGL(mainCanvas, MW, MH, eyeW, eyeH, {
      shiftL: state.stereoShiftL, shiftR: state.stereoShiftR,
      angle: state.stereoAngle * Math.PI / 180,
      k1: state.stereoDistort, k2: 0,
      fill: state.stereoFill,
    });
  }

  requestAnimationFrame(processFrame);
}

startBtn.onclick = async () => {
  try {
    statusEl.textContent = 'Requesting camera…';
    const { PW, PH } = await startCamera();
    state.running = true;
    state.lastFrameTime = 0;  // first frame computes dt=0, no startup jump
    startBtn.style.display = 'none';
    controlsEl.style.display = 'flex';
    calControls.style.display = 'flex';
    panelToggle.style.display = 'block';
    overlayPanel.classList.add('open');
    cvStatusEl.textContent = `Running at ${PW}×${PH} proc res — pure JS`;
    statusEl.textContent = 'Tip: turn feed off (white), then calibrate by tapping each piece border';
    buildUI();
    processFrame();
  } catch (e) {
    statusEl.textContent = 'Camera error: ' + e.message +
      (location.protocol !== 'https:' && location.hostname !== 'localhost'
        ? ' — iOS requires HTTPS for camera access.' : '');
  }
};

// ── boot ──────────────────────────────────────────────────────────────────────
wireSliders();
wireStereoSlider();
wireViewControls();
wireCalibration();
wireSaveLoad();
wireMediaLinks();
syncSliders();
buildUI();

const configURL = new URLSearchParams(location.search).get('config');
if (configURL) loadConfigFromURL(configURL);