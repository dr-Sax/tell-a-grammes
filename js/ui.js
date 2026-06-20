// ── UI: piece rows + view controls ────────────────────────────────────────────
// Builds the per-piece control rows, wires the tolerance sliders, and the view
// controls (feed / fullscreen). Calibration sampling and save/load live in
// calibration.js.

import { PIECES, N, params } from './config.js';
import { state } from './state.js';
import { hsvToHex, hueDiff360 } from './hsv.js';
import { tapHint, crosshair, uiEl, $ } from './dom.js';
import { pieceMedia, disposeMedia, loadMediaFile } from './media.js';

const SLIDER_KEYS = ['htol', 'stol', 'vtol', 'minArea'];

export function wireSliders() {
  for (const key of SLIDER_KEYS) {
    const range = $(key + 'Range'), val = $(key + 'Val');
    range.oninput = () => { params[key] = +range.value; val.textContent = params[key]; };
  }
}

// Reflect the current params back into the slider DOM (defaults + after load).
export function syncSliders() {
  for (const key of SLIDER_KEYS) {
    const range = $(key + 'Range'), val = $(key + 'Val');
    if (range) range.value = params[key];
    if (val) val.textContent = params[key];
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
      buildUI();
    };

    main.append(sw, lbl, stats, calBtn, clrBtn);
    row.append(main, buildMediaRow(i));
    uiEl.appendChild(row);
  });
}

function buildMediaRow(i) {
  const mediaRow = document.createElement('div');
  mediaRow.className = 'piece-media';
  const m = pieceMedia[i];

  const thumb = document.createElement('img');
  thumb.className = 'media-thumb' + (m ? ' on' : '');
  thumb.id = `thumb${i}`;
  if (m) {
    if (m.type === 'image') {
      thumb.src = m.el.src;
    } else if (m.type === 'video') {
      const tc = document.createElement('canvas');
      tc.width = 40; tc.height = 28;
      try { tc.getContext('2d').drawImage(m.el, 0, 0, 40, 28); } catch (e) {}
      thumb.src = tc.toDataURL();
    } else if (m.type === 'captions') {
      // No frame to thumbnail — draw a "CC" badge so it's visually distinct.
      const tc = document.createElement('canvas');
      tc.width = 40; tc.height = 28;
      const c = tc.getContext('2d');
      c.fillStyle = '#16202e'; c.fillRect(0, 0, 40, 28);
      c.fillStyle = '#7ab8f5';
      c.font = '700 13px system-ui, sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('CC', 20, 15);
      thumb.src = tc.toDataURL();
    }
  }

  const nameEl = document.createElement('span');
  nameEl.className = 'media-name';
  nameEl.textContent = m
    ? (m.type === 'captions' ? `${m.name} · ${m.cues.length}w` : m.name)
    : 'no media';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*,video/*,.json,application/json';
  fileInput.style.display = 'none';
  fileInput.onchange = e => {
    const file = e.target.files[0];
    if (file) loadMediaFile(i, file, buildUI);
    e.target.value = '';
  };

  const upBtn = document.createElement('button');
  upBtn.className = 'upload-btn';
  upBtn.textContent = m ? '⟳ swap' : '+ media';
  upBtn.onclick = () => fileInput.click();

  const clrMediaBtn = document.createElement('button');
  clrMediaBtn.className = 'clear-media-btn';
  clrMediaBtn.textContent = '✕';
  clrMediaBtn.disabled = !m;
  clrMediaBtn.onclick = () => { disposeMedia(i); buildUI(); };

  mediaRow.append(thumb, nameEl, fileInput, upBtn, clrMediaBtn);
  return mediaRow;
}

// ── view controls: feed / fullscreen ──────────────────────────────────────────
export function wireViewControls() {
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
}