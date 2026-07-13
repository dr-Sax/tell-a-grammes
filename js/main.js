// ── main: orchestration + frame loop ──────────────────────────────────────────
// Entry point. Wires the modules together and runs the per-frame pipeline.
//
// One pass, not three. There is no longer a "blob mode" vs "match mode" vs
// "fill mode": those were three different answers to "which pixels belong to
// this colour", and the quantizer answers it once, for every colour at once.
//
//   frame → assign every pixel to its nearest ink cluster (CIELAB k-means)
//         → per colour: smoothed membership field → RGBA stencil
//         → per colour: pour that colour's media through the stencil
//
// No polygons, no hue rotation, no largest-blob arbitration, no jump gate.

import { N, MISS_GRACE_FRAMES } from './config.js';
import { state } from './state.js';
import {
  mainCanvas, mainCtx, statusEl, cvStatusEl, startBtn, controlsEl, calControls,
  panelToggle, overlayPanel, stereoCanvas,
} from './dom.js';
import { readCanvas, readCtx, drawOriented, startCamera } from './camera.js';
import { classifyFrame, detectClassStencil } from './tracker.js';
import { resetClusters } from './quantize.js';
import { renderDebugBar, drawFillOverlay } from './render.js';
import { buildUI, syncSliders, wireSliders, wireViewControls, wireStereoSlider } from './ui.js';
import { wireCalibration } from './calibrate.js';
import { wireSaveLoad, loadConfigFromURL } from './configIO.js';
import { wireMediaLinks } from './links.js';
import { renderStereoGL } from './stereoGL.js';
import { pieceMedia } from './media.js';

function processFrame(now) {
  if (!state.running) return;
  const t = (typeof now === 'number') ? now : performance.now();
  const dt = state.lastFrameTime ? Math.min(0.25, (t - state.lastFrameTime) / 1000) : 0;
  state.lastFrameTime = t;

  const PW = readCanvas.width, PH = readCanvas.height;
  const MW = mainCanvas.width, MH = mainCanvas.height;

  drawOriented(readCtx, PW, PH);
  const img = readCtx.getImageData(0, 0, PW, PH).data;

  if (state.showFeed) drawOriented(mainCtx, MW, MH);
  else { mainCtx.fillStyle = '#fff'; mainCtx.fillRect(0, 0, MW, MH); }

  // One classification pass resolves every calibrated colour at once. The
  // returned palette maps class index → piece index (calibrated slots may be
  // sparse, so the two are not the same number).
  const palette = classifyFrame(img, state.calibrated, PW, PH);

  const counts = Array(N).fill(0);

  for (let c = 0; c < palette.length; c++) {
    const pi = palette[c].pi;
    const res = detectClassStencil(c, PW, PH);

    if (!res) {
      state.missStreak[pi]++;
      state.lastCentroid[pi] = null;
      continue;
    }

    // Occlusion needs no special handling. A hand crossing the print doesn't
    // blank the overlay in one frame, and it can't snap it somewhere wrong
    // either — the membership field simply decays where the colour stops being
    // visible and recovers where it returns.
    state.missStreak[pi] = 0;
    state.lastCentroid[pi] = res.centroid;
    state.captionElapsed[pi] += dt;
    counts[pi] = res.filled;

    // A calibrated colour with no media is a BACKGROUND class: tracked, but not
    // drawn. This is not a cosmetic nicety — it's structural, and it's what
    // makes the whole classifier work.
    //
    // Nearest-colour assignment partitions ALL of colour space among the
    // calibrated entries. There is no "none of the above". Calibrate only two
    // blues and every pixel in the room — paper, skin, shadow — is handed to
    // whichever blue it happens to sit closer to, because it has nowhere else
    // to go. (White paper is ΔE 17 from a light blue. It doesn't stand a
    // chance.) Worse, k-means then drags that blue's centre toward the paper,
    // since the paper outnumbers the ink by an order of magnitude, and the class
    // permanently comes to mean "pale".
    //
    // The cure is to give those colours somewhere to go: tap the paper white,
    // tap the black, and attach no media to them. They then compete for their
    // own pixels, the ink centres stay on the ink, and nothing is drawn for
    // them. Every colour in frame needs an entry — that's the rule.
    if (!pieceMedia[pi]) continue;

    drawFillOverlay(pi, res, PW, PH, MW, MH);
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
    resetClusters();
    startBtn.style.display = 'none';
    controlsEl.style.display = 'flex';
    calControls.style.display = 'flex';
    panelToggle.style.display = 'block';
    overlayPanel.classList.add('open');
    cvStatusEl.textContent = `Running at ${PW}×${PH} proc res — pure JS`;
    statusEl.textContent = 'Fill the frame with the print, then calibrate by tapping each colour';
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