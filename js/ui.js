// ── UI: piece rows + view controls ────────────────────────────────────────────
// Builds the per-piece control rows, wires the tolerance sliders, and the view
// controls (feed / fullscreen). Calibration sampling and save/load live in
// calibration.js.

import { PIECES, N, params } from './config.js';
import { state } from './state.js';
import { hsvToHex, hueDiff360 } from './hsv.js';
import { tapHint, crosshair, uiEl, $ } from './dom.js';
import { pieceMedia, disposeMedia, loadMediaFile } from './media.js';
import { captionThumbURL } from './caption.js';

// Tiny DOM builder. `props` keys map to element properties (className, onclick,
// textContent, src, disabled…); `style` is special-cased to Object.assign onto
// the inline style. Remaining args are children (skipped if null/undefined).
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style') Object.assign(n.style, v);
    else n[k] = v;
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

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
    const cal = state.calibrated[i];

    const sw = el('div', { className: 'swatch', style: {
      background: cal ? hsvToHex(cal.h, cal.s, cal.v) : p.color,
      opacity: cal ? '1' : '0.35',
    }});

    const lbl = el('span', { className: 'piece-label', textContent: p.name });
    const conflict = conflictsWith(i);
    if (conflict !== null) {
      const dist = Math.round(hueDiff360(cal.h, state.calibrated[conflict].h));
      lbl.textContent += ` ⚠ ~${dist}°`;
      lbl.style.color = '#c84';
    }

    const stats = el('span', { className: 'piece-stats',
      textContent: cal ? `H${Math.round(cal.h)}° S${cal.s.toFixed(2)}` : '—' });

    const calBtn = el('button', {
      className: 'cal-btn' + (state.calibrating === i ? ' active' : '') + (cal ? ' done' : ''),
      textContent: cal ? '✓ recal' : 'calibrate',
      disabled: !state.running,
      onclick: () => {
        state.calibrating = state.calibrating === i ? -1 : i;
        const on = state.calibrating >= 0;
        tapHint.style.display   = on ? 'block' : 'none';
        crosshair.style.display = on ? 'block' : 'none';
        tapHint.textContent = on ? `Tap the colored BORDER of ${PIECES[state.calibrating].name}` : '';
        buildUI();
      },
    });

    const clrBtn = el('button', {
      className: 'clear-btn', textContent: '✕', title: 'Clear calibration',
      disabled: !cal,
      onclick: () => { state.calibrated[i] = null; state.smoothHulls[i] = null; buildUI(); },
    });

    const main = el('div', { className: 'piece-main' }, sw, lbl, stats, calBtn, clrBtn);
    uiEl.appendChild(el('div', { className: 'piece-row' }, main, buildMediaRow(i)));
  });
}

function buildMediaRow(i) {
  const m = pieceMedia[i];

  const thumb = el('img', { className: 'media-thumb' + (m ? ' on' : ''), id: `thumb${i}` });
  if (m) {
    if (m.type === 'image') {
      thumb.src = m.el.src;
    } else if (m.type === 'caption') {
      thumb.src = captionThumbURL();          // captions have no frame — "CC" badge
    } else {
      // video or gif: el is a video/canvas — snapshot the current frame
      const tc = document.createElement('canvas');
      tc.width = 40; tc.height = 28;
      try { tc.getContext('2d').drawImage(m.el, 0, 0, 40, 28); } catch (e) {}
      thumb.src = tc.toDataURL();
    }
  }

  // image/video frames + JSON caption cue files. The explicit .json extension
  // is needed alongside the MIME type so iOS Safari's picker doesn't grey it out.
  const fileInput = el('input', {
    type: 'file',
    accept: 'image/*,video/*,application/json,.json',
    style: { display: 'none' },
    onchange: e => {
      const file = e.target.files[0];
      if (file) loadMediaFile(i, file, buildUI);
      e.target.value = '';
    },
  });

  const nameEl = el('span', { className: 'media-name', textContent: m ? m.name : 'no media' });

  const upBtn = el('button', {
    className: 'upload-btn', textContent: m ? '⟳ swap' : '+ media',
    onclick: () => fileInput.click(),
  });

  const clrMediaBtn = el('button', {
    className: 'clear-media-btn', textContent: '✕', disabled: !m,
    onclick: () => { disposeMedia(i); buildUI(); },
  });

  return el('div', { className: 'piece-media' }, thumb, nameEl, fileInput, upBtn, clrMediaBtn);
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