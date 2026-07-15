// ── UI: piece rows + view controls ────────────────────────────────────────────
// Builds the per-piece list, wires the tolerance sliders, and the view
// controls (feed / fullscreen / stereo). Calibration sampling lives in
// calibrate.js; save/load in configIO.js; per-piece media/framing controls in
// ui-media.js.

import { PIECES, params, TOL_SLIDERS } from './config.js';
import { state } from './state.js';
import { swatchColor } from './hsv.js';
import {
  tapHint, crosshair, uiEl, controlsEl, overlayPanel, panelToggle, $,
  mainCanvas, stereoCanvas, canvasWrap, stereoControlsEl, statusEl
} from './dom.js';
import { buildMediaRow } from './ui-media.js';
import { initStereoGL } from './stereoGL.js';

let glReady = false;

export function wireSliders() {
  controlsEl.innerHTML = '';
  for (const s of TOL_SLIDERS) {
    const group = document.createElement('div');
    group.className = 'ctrl-group';

    const val = document.createElement('span');
    val.id = s.key + 'Val';
    val.textContent = params[s.key];

    const label = document.createElement('label');
    label.append(s.label + ' ', val);

    const range = document.createElement('input');
    range.type = 'range';
    range.id = s.key + 'Range';
    range.min = s.min; range.max = s.max; range.step = s.step;
    range.value = params[s.key];
    range.style.flex = '1';
    range.oninput = () => { params[s.key] = +range.value; val.textContent = params[s.key]; };

    group.append(label, range);
    controlsEl.appendChild(group);
  }
}

// Reflect the current params back into the slider DOM (after a config load).
export function syncSliders() {
  for (const s of TOL_SLIDERS) {
    const range = $(s.key + 'Range'), val = $(s.key + 'Val');
    if (range) range.value = params[s.key];
    if (val) val.textContent = params[s.key];
  }
}

function buildStereoRange({ label, min, max, step, get, set, format }) {
  const val = document.createElement('span');
  val.textContent = format(get());

  const lbl = document.createElement('label');
  lbl.append(label + ' ', val);

  const range = document.createElement('input');
  range.type = 'range';
  range.min = min; range.max = max; range.step = step;
  range.value = get();
  range.style.flex = '1';
  range.oninput = () => {
    set(+range.value);
    val.textContent = format(get());
  };

  const group = document.createElement('div');
  group.className = 'ctrl-group';
  group.append(lbl, range);
  return group;
}

export function wireStereoSlider() {
  stereoControlsEl.innerHTML = '';

  stereoControlsEl.append(
    buildStereoRange({
      label: 'Eye angle', min: -15, max: 15, step: 0.5,
      get: () => state.stereoAngle,
      set: v => { state.stereoAngle = v; },
      format: v => v.toFixed(1) + '°',
    }),
    buildStereoRange({
      label: 'L shift', min: -0.3, max: 0.3, step: 0.005,
      get: () => state.stereoShiftL,
      set: v => { state.stereoShiftL = v; },
      format: v => Math.round(v * 100) + '%',
    }),
    buildStereoRange({
      label: 'R shift', min: -0.3, max: 0.3, step: 0.005,
      get: () => state.stereoShiftR,
      set: v => { state.stereoShiftR = v; },
      format: v => Math.round(v * 100) + '%',
    }),
    buildStereoRange({
      label: 'Distort', min: -0.5, max: 0.5, step: 0.01,
      get: () => state.stereoDistort,
      set: v => { state.stereoDistort = v; },
      format: v => v.toFixed(2),
    }),
    buildStereoRange({
      label: 'Fill', min: 1, max: 2, step: 0.01,
      get: () => state.stereoFill,
      set: v => { state.stereoFill = v; },
      format: v => v.toFixed(2) + '×',
    }),
  );
}

// The old conflictsWith() warned when two pieces had similar hues, because the
// per-piece hue bands would then overlap and both claim the same pixels. Under
// nearest-colour classification that is no longer a fault condition — it's the
// headline feature. Two blues 15° apart are simply two palette entries, and the
// classifier puts the boundary exactly between them. The warning is gone.

export function buildUI() {
  uiEl.innerHTML = '';
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
    stats.textContent = cal && Number.isFinite(cal.r)
      ? `${cal.r},${cal.g},${cal.b}`
      : (cal ? `H${Math.round(cal.h)}°` : '—');

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
export function wireViewControls() {
  panelToggle.onclick = () => overlayPanel.classList.toggle('open');

  const fsBtn = $('fsBtn'), exitFs = $('exitFs');

  const enterImmersive = () => {
    document.body.classList.add('immersive');
    // Real Fullscreen API where it exists (desktop / Android / iPadOS). iPhone
    // Safari has none — the CSS class handles layout there.
    const wrap = $('canvasWrap');
    const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
    if (req) { try { const p = req.call(wrap); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
    setTimeout(() => window.scrollTo(0, 1), 80);  // nudge Safari toolbars to collapse
  };
  const exitImmersive = () => {
    document.body.classList.remove('immersive');
    const ex = document.exitFullscreen || document.webkitExitFullscreen;
    if (ex && (document.fullscreenElement || document.webkitFullscreenElement)) {
      try { const p = ex.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    }
  };
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