// ── UI: piece rows + view controls ────────────────────────────────────────────
// Builds the per-piece list, wires the tolerance sliders, and the view
// controls (feed / fullscreen). Calibration sampling lives in calibrate.js;
// save/load in configIO.js; per-piece media/framing controls in ui-media.js.

import { PIECES, N, params, TOL_SLIDERS } from './config.js';
import { state } from './state.js';
import { hsvToHex, hueDiff360 } from './hsv.js';
import { tapHint, crosshair, uiEl, controlsEl, overlayPanel, panelToggle, $, mainCanvas, stereoCanvas} from './dom.js';
import { buildMediaRow } from './ui-media.js';

// Builds the detection-tolerance controls (#controls) from TOL_SLIDERS —
// index.html no longer hardcodes these, so this is the only place their
// min/max/step/default can drift, and it can't drift from config.js's
// `params` defaults since it reads them directly.
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

function conflictsWith(i) {
  const cal = state.calibrated[i];
  if (!cal) return null;
  for (let j = 0; j < N; j++) {
    if (j === i || !state.calibrated[j]) continue;
    if (hueDiff360(cal.h, state.calibrated[j].h) < params.htol * 2) return j;
  }
  return null;
}

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
    sw.style.background = cal ? hsvToHex(cal.h, cal.s, cal.v) : p.color;
    sw.style.opacity = cal ? '1' : '0.35';

    const lbl = document.createElement('span');
    lbl.className = 'piece-label';
    lbl.textContent = p.name;
    const conflict = conflictsWith(i);
    if (conflict !== null) {
      const dist = Math.round(hueDiff360(cal.h, state.calibrated[conflict].h));
      lbl.textContent += ` ⚠ ~${dist}°`;
      lbl.style.color = '#c84';
    }

    const stats = document.createElement('span');
    stats.className = 'piece-stats';
    stats.textContent = cal ? `H${Math.round(cal.h)}° S${cal.s.toFixed(2)}` : '—';

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
      tapHint.textContent = on ? `Tap the colored BORDER of ${PIECES[state.calibrating].name}` : '';
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
      state.smoothHulls[i] = null;
      state.lastCentroid[i] = null;
      state.missStreak[i] = 0;
      buildUI();
    };

    main.append(sw, lbl, stats, calBtn, clrBtn);
    row.append(main, buildMediaRow(i));
    uiEl.appendChild(row);
  });
}

// ── view controls: feed / fullscreen ──────────────────────────────────────────
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
    state.stereo = !state.stereo;
    mainCanvas.style.display   = state.stereo ? 'none'  : 'block';
    stereoCanvas.style.display = state.stereo ? 'block' : 'none';
    stereoBtn.classList.toggle('active', state.stereo);
    stereoBtn.textContent = state.stereo ? '👓 stereo on' : '👓 stereo';
  };
}