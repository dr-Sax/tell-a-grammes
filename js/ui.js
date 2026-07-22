// ── UI: piece rows + view controls ────────────────────────────────────────────
// Builds the per-piece list, wires the tolerance sliders, and the view
// controls (feed / fullscreen / stereo). Calibration sampling lives in
// calibrate.js; save/load in configIO.js; per-piece media/framing controls in
// ui-media.js.

import { PIECES, params, TOL_SLIDERS } from './config.js';
import { state } from './state.js';
import { makeSlider } from './sliders.js';
import { swatchColor } from './color.js';
import {
  tapHint, crosshair, uiEl, controlsEl, overlayPanel, panelToggle, $,
  mainCanvas, stereoCanvas, canvasWrap, stereoControlsEl, statusEl
} from './dom.js';
import { buildMediaRow } from './ui-media.js';
import { initStereoGL } from './stereoGL.js';
import { attachAudio, disposeAudio, startAudio, audioURL } from './audio.js';

let glReady = false;

// Detection sliders (top control bar), plus their sync handles — the factory
// returns a sync() per slider, so a config load re-reads params through the
// same closure the slider itself uses. No DOM ids involved.
let tolSyncs = [];

export function wireSliders() {
  controlsEl.innerHTML = '';
  tolSyncs = TOL_SLIDERS.map(s => {
    const { el, sync } = makeSlider({
      label: s.label, min: s.min, max: s.max, step: s.step,
      get: () => params[s.key],
      set: v => { params[s.key] = v; },
    });
    controlsEl.appendChild(el);
    return sync;
  });
}

// Reflect the current params back into the sliders (after a config load).
export function syncSliders() {
  for (const sync of tolSyncs) sync();
}

export function wireStereoSlider() {
  stereoControlsEl.innerHTML = '';
  const stereo = (label, min, max, step, key, format) =>
    makeSlider({
      label, min, max, step, format,
      get: () => state[key],
      set: v => { state[key] = v; },
    }).el;

  stereoControlsEl.append(
    stereo('Eye angle', -15, 15, 0.5, 'stereoAngle', v => v.toFixed(1) + '°'),
    stereo('L shift', -0.3, 0.3, 0.005, 'stereoShiftL', v => Math.round(v * 100) + '%'),
    stereo('R shift', -0.3, 0.3, 0.005, 'stereoShiftR', v => Math.round(v * 100) + '%'),
    stereo('Distort', -0.5, 0.5, 0.01, 'stereoDistort', v => v.toFixed(2)),
    stereo('Fill', 1, 2, 0.01, 'stereoFill', v => v.toFixed(2) + '×'),
  );
}

// The old conflictsWith() warned when two pieces had similar hues, because the
// per-piece hue bands would then overlap and both claim the same pixels. Under
// nearest-colour classification that is no longer a fault condition — it's the
// headline feature. Two blues 15° apart are simply two palette entries, and the
// classifier puts the boundary exactly between them. The warning is gone.

// Global audio master-clock row: one soundtrack for the whole config, not a
// per-piece attachment, so it sits above the piece list. Attaching mid-session
// is itself a user gesture, so play() fires inside it and iOS allows it.
function buildAudioRow() {
  const row = document.createElement('div');
  row.className = 'piece-row';
  const main = document.createElement('div');
  main.className = 'piece-main';

  const lbl = document.createElement('span');
  lbl.className = 'piece-label';
  const url = audioURL();
  lbl.textContent = url
    ? `🔊 ${decodeURIComponent((url.split('/').pop() || url).split('?')[0]) || url}`
    : '🔇 no audio';

  const urlBtn = document.createElement('button');
  urlBtn.className = 'cal-btn' + (url ? ' done' : '');
  urlBtn.textContent = '🔗';
  urlBtn.title = 'Attach audio master clock (URL)';
  urlBtn.onclick = () => {
    const u = prompt('Audio master clock: mp3 URL', url || '');
    if (!u) return;
    attachAudio(u.trim());
    if (state.running) startAudio();
    buildUI();
  };

  const clrBtn = document.createElement('button');
  clrBtn.className = 'clear-btn';
  clrBtn.textContent = '✕';
  clrBtn.title = 'Detach audio';
  clrBtn.disabled = !url;
  clrBtn.onclick = () => { disposeAudio(); buildUI(); };

  main.append(lbl, urlBtn, clrBtn);
  row.appendChild(main);
  return row;
}

export function buildUI() {
  uiEl.innerHTML = '';
  uiEl.appendChild(buildAudioRow());
  PIECES.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'piece-row';

    const main = document.createElement('div');
    main.className = 'piece-main';

    const cal = state.calibrated[i];

    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = swatchColor(cal, p.color);
    sw.style.opacity = cal ? '1' : '0.35';

    const lbl = document.createElement('span');
    lbl.className = 'piece-label';
    lbl.textContent = p.name;

    const stats = document.createElement('span');
    stats.className = 'piece-stats';
    stats.textContent = cal ? `${cal.r},${cal.g},${cal.b}` : '—';

    const calBtn = document.createElement('button');
    calBtn.className = 'cal-btn' +
      (state.calibrating === i ? ' active' : '') + (cal ? ' done' : '');
    calBtn.textContent = cal ? '✓ recal' : 'calibrate';
    calBtn.disabled = !state.running;
    calBtn.onclick = () => {
      state.calibrating = state.calibrating === i ? -1 : i;
      const on = state.calibrating >= 0;
      tapHint.style.display   = on ? 'block' : 'none';
      crosshair.style.display = on ? 'block' : 'none';
      tapHint.textContent = on ? `Tap a region of ${PIECES[state.calibrating].name}` : '';
      // collapse the panel out of the way while actively calibrating — the
      // piece needs to be fully visible to tap; reopen it if the button is
      // pressed again to cancel (calibrateAt reopens it on a successful tap).
      overlayPanel.classList.toggle('open', !on);
      buildUI();
    };

    const clrBtn = document.createElement('button');
    clrBtn.className = 'clear-btn';
    clrBtn.textContent = '✕';
    clrBtn.title = 'Clear calibration';
    clrBtn.disabled = !cal;
    clrBtn.onclick = () => {
      state.calibrated[i] = null;
      buildUI();
    };

    main.append(sw, lbl, stats, calBtn, clrBtn);
    row.append(main, buildMediaRow(i));
    uiEl.appendChild(row);
  });
}

// ── view controls: feed / fullscreen / stereo ─────────────────────────────────
// Module-scope so main.js can enter immersive mode straight from the Start
// camera click (that click is the user gesture requestFullscreen needs — like
// startAudio, it must run synchronously before the camera await).
export const enterImmersive = () => {
  document.body.classList.add('immersive');
  // Real Fullscreen API where it exists (desktop / Android / iPadOS). iPhone
  // Safari has none — the CSS class handles layout there.
  const wrap = $('canvasWrap');
  const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
  if (req) { try { const p = req.call(wrap); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
  setTimeout(() => window.scrollTo(0, 1), 80);  // nudge Safari toolbars to collapse
};

export const exitImmersive = () => {
  document.body.classList.remove('immersive');
  const ex = document.exitFullscreen || document.webkitExitFullscreen;
  if (ex && (document.fullscreenElement || document.webkitFullscreenElement)) {
    try { const p = ex.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }
};

export function wireViewControls() {
  panelToggle.onclick = () => overlayPanel.classList.toggle('open');

  const fsBtn = $('fsBtn'), exitFs = $('exitFs');

  fsBtn.onclick = enterImmersive;
  exitFs.onclick = exitImmersive;
  const onFsChange = () => {
    if (!document.fullscreenElement && !document.webkitFullscreenElement)
      document.body.classList.remove('immersive');
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  const feedBtn = $('feedBtn');
  feedBtn.onclick = () => {
    state.showFeed = !state.showFeed;
    feedBtn.textContent = state.showFeed ? '📷 feed on' : '⬜ feed off';
    feedBtn.classList.toggle('active', !state.showFeed);
  };


  const stereoBtn = $('stereoBtn');
  stereoBtn.onclick = () => {
    if (!state.stereo && !glReady) {
      glReady = initStereoGL(stereoCanvas);
      if (!glReady) { statusEl.textContent = 'Stereo needs WebGL — this browser blocked it'; return; }
    }
    state.stereo = !state.stereo;
    mainCanvas.style.display   = state.stereo ? 'none'  : 'block';
    stereoCanvas.style.display = state.stereo ? 'block' : 'none';
    stereoControlsEl.style.display = state.stereo ? 'flex' : 'none';
    const w = mainCanvas.width  || 4;
    const h = mainCanvas.height || 3;
    canvasWrap.style.aspectRatio = state.stereo ? `${w * 2} / ${h}` : `${w} / ${h}`;
    stereoBtn.classList.toggle('active', state.stereo);
    stereoBtn.textContent = state.stereo ? '👓 stereo on' : '👓 stereo';
  };
}