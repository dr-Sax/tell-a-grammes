// ── UI: piece rows + view controls ────────────────────────────────────────────
// Builds the per-piece control rows, wires the tolerance sliders, and the view
// controls (feed / fullscreen). Calibration sampling and save/load live in
// calibration.js.

import { PIECES, N, params, MEDIA_SLIDERS } from './config.js';
import { state } from './state.js';
import { hsvToHex, hueDiff360 } from './hsv.js';
import { tapHint, crosshair, uiEl, overlayPanel, panelToggle, statusEl, $ } from './dom.js';
import { pieceMedia, disposeMedia, loadMediaFile, loadMediaFromURL } from './media.js';
import { captionThumbURL } from './caption.js';

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

// Per-piece framing sliders (zoom / x-shift / y-shift). Mutates the piece's
// state.mediaAdjust object IN PLACE on input — the rAF loop reads it next frame,
// so changes are immediate. Never calls buildUI (that would interrupt the drag).
function buildAdjustRow(i) {
  const row = document.createElement('div');
  row.className = 'piece-adjust';
  const adj = state.mediaAdjust[i];

  for (const s of MEDIA_SLIDERS) {
    const group = document.createElement('label');
    group.className = 'adjust-group';

    const tag = document.createElement('span');
    tag.className = 'adjust-tag';
    tag.textContent = s.label;
    tag.title = 'reset';
    tag.onclick = () => { adj[s.key] = s.def; range.value = s.def; val.textContent = (+s.def).toFixed(2); };

    const range = document.createElement('input');
    range.type = 'range';
    range.min = s.min; range.max = s.max; range.step = s.step;
    range.value = adj[s.key];

    const val = document.createElement('span');
    val.className = 'adjust-val';
    val.textContent = (+adj[s.key]).toFixed(2);

    range.oninput = () => { adj[s.key] = +range.value; val.textContent = (+range.value).toFixed(2); };

    group.append(tag, range, val);
    row.appendChild(group);
  }
  return row;
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
    } else if (m.type === 'caption') {
      // captions have no frame — show a "CC" badge instead
      thumb.src = captionThumbURL();
    } else {
      // video or gif: el is a video/canvas — snapshot the current frame
      const tc = document.createElement('canvas');
      tc.width = 40; tc.height = 28;
      try { tc.getContext('2d').drawImage(m.el, 0, 0, 40, 28); } catch (e) {}
      thumb.src = tc.toDataURL();
    }
  }

  const nameEl = document.createElement('span');
  nameEl.className = 'media-name';
  nameEl.textContent = m ? m.name : 'no media';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  // image/video frames + JSON caption cue files. The explicit .json extension
  // is needed alongside the MIME type so iOS Safari's picker doesn't grey it out.
  fileInput.accept = 'image/*,video/*,application/json,.json';
  fileInput.style.display = 'none';
  fileInput.onchange = e => {
    const file = e.target.files[0];
    // loadMediaFile only calls this refresh callback on a SUCCESSFUL attach
    // (failure paths just set statusEl text) — so closing the panel here means
    // it collapses right when there's something new to look at, not on errors.
    if (file) loadMediaFile(i, file, () => { buildUI(); overlayPanel.classList.remove('open'); });
    e.target.value = '';
  };

  const upBtn = document.createElement('button');
  upBtn.className = 'upload-btn';
  upBtn.textContent = m ? '⟳ swap' : '+ media';
  upBtn.onclick = () => fileInput.click();

  // Attaching from a URL (vs. a local file) is what lets this piece's media
  // round-trip through a saved config — see getCalData() in calibration.js,
  // which can only reference media by URL, not re-embed a local pick. Kept
  // deliberately minimal (a native prompt) rather than a whole persistent
  // input field, matching the rest of this UI's style.
  const urlBtn = document.createElement('button');
  urlBtn.className = 'upload-btn';
  urlBtn.title = 'Attach media by URL — required for this piece\'s media to be included when you save a config';
  urlBtn.textContent = '🔗';
  urlBtn.onclick = () => {
    const url = prompt(`${PIECES[i].name}: media URL`, m && m.sourceURL || '');
    if (!url) return;
    statusEl.textContent = `${PIECES[i].name}: loading…`;
    loadMediaFromURL(i, url, () => { buildUI(); overlayPanel.classList.remove('open'); })
      .catch(err => { statusEl.textContent = `${PIECES[i].name}: ${err.message || 'load failed'}`; });
  };

  const clrMediaBtn = document.createElement('button');
  clrMediaBtn.className = 'clear-media-btn';
  clrMediaBtn.textContent = '✕';
  clrMediaBtn.disabled = !m;
  clrMediaBtn.onclick = () => { disposeMedia(i); buildUI(); };

  mediaRow.append(thumb, nameEl, fileInput, upBtn, urlBtn, clrMediaBtn);
  if (!m) return mediaRow;

  const wrap = document.createElement('div');
  wrap.append(mediaRow, buildAdjustRow(i));
  return wrap;
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
}