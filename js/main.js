// ── main: orchestration + frame loop ──────────────────────────────────────────
// Entry point. Wires the modules together and runs the per-frame pipeline.

import { PIECES, N, LERP, MISS_GRACE_FRAMES } from './config.js';
import { state } from './state.js';
import { matchAndLerp } from './geometry.js';
import { mainCanvas, mainCtx, statusEl, cvStatusEl, startBtn, controlsEl, calControls, panelToggle, overlayPanel } from './dom.js';
import { readCanvas, readCtx, drawOriented, startCamera } from './camera.js';
import { computeHSV, detectPiece } from './tracker.js';
import { drawOverlay, renderDebugBar } from './render.js';
import { buildUI, syncSliders, wireSliders, wireViewControls } from './ui.js';
import { wireCalibration, wireSaveLoad, loadConfigFromURL } from './calibration.js';

function processFrame(now) {
  if (!state.running) return;

  // Delta-time for the per-piece caption clocks. rAF passes a DOMHighResTimeStamp
  // (same origin as performance.now); the very first call comes in argument-less
  // from the start handler, so fall back. Clamp so a backgrounded tab — where
  // rAF stalls and resumes with a huge gap — can't skip the captions ahead.
  const t = (typeof now === 'number') ? now : performance.now();
  const dt = state.lastFrameTime ? Math.min(0.25, (t - state.lastFrameTime) / 1000) : 0;
  state.lastFrameTime = t;

  const PW = readCanvas.width, PH = readCanvas.height;
  const MW = mainCanvas.width, MH = mainCanvas.height;
  const scaleX = MW / PW, scaleY = MH / PH;

  drawOriented(readCtx, PW, PH);
  computeHSV(readCtx.getImageData(0, 0, PW, PH).data, PW * PH);

  // background: live feed, or a white lightbox (detection reads the proc buffer
  // either way, so the choice doesn't affect tracking).
  if (state.showFeed) drawOriented(mainCtx, MW, MH);
  else { mainCtx.fillStyle = '#fff'; mainCtx.fillRect(0, 0, MW, MH); }

  const counts = Array(N).fill(0);

  for (let i = 0; i < N; i++) {
    const cal = state.calibrated[i];
    if (!cal) continue;

    const found = detectPiece(cal, PW, PH, state.lastCentroid[i]);

    if (!found) {
      state.missStreak[i]++;
      if (state.missStreak[i] > MISS_GRACE_FRAMES) {
        // real loss (piece removed, or gone long enough to stop trusting the
        // last position) — clear so the next hit re-acquires from scratch.
        state.smoothHulls[i] = null;
        state.smoothArea[i] = 0;
        state.lastCentroid[i] = null;
      } else if (state.smoothHulls[i]) {
        // brief dropout — e.g. a hand passing over the piece for a frame or
        // two. Hold the last known shape on screen instead of letting the
        // overlay flicker off; lastCentroid is left untouched so detection
        // keeps searching near where the piece actually is.
        drawOverlay(state.smoothHulls[i], i, MW, MH);
      }
      continue;
    }

    state.missStreak[i] = 0;
    state.lastCentroid[i] = found.centroid;

    // Detected this frame → advance this piece's caption clock. Pieces that
    // weren't found hit the `continue` above, so their clock is left untouched
    // (pause-on-dropout, resume-from-the-same-word). Uncalibrated pieces never
    // reach here either. This is the whole sync model for captions.
    state.captionElapsed[i] += dt;

    counts[i] = found.filled;
    const poly = found.poly.map(p => [p[0] * scaleX, p[1] * scaleY]);

    // stability guard: if this frame's area jumps wildly vs. the running mean
    // it's likely a partial detection (a momentary gap in the border) — mostly
    // hold the previous shape instead of snapping to it.
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

  renderDebugBar(counts);
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
wireViewControls();
wireCalibration();
wireSaveLoad();
syncSliders();
buildUI();

// Optional startup config link: ?config=<url-encoded URL to a config JSON>.
// Runs before the camera even starts — tolerances/colours/media/framing are
// all in place by the time "start camera" is pressed, so a shared link can
// carry a whole setup instead of a manual save-then-load round trip. Same
// CORS requirement as media URLs: the host has to actually allow cross-origin
// fetches (see loadConfigFromURL's comment in calibration.js).
const configURL = new URLSearchParams(location.search).get('config');
if (configURL) loadConfigFromURL(configURL);