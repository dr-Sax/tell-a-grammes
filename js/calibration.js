// ── calibration: colour sampling + save/load ──────────────────────────────────
// Tap-to-sample a piece's border colour, and persist/restore the full setup.

import { PIECES, N, params, MEDIA_SLIDERS } from './config.js';
import { state } from './state.js';
import { rgb2hsv } from './hsv.js';
import { mainCanvas, tapHint, crosshair, statusEl, overlayPanel, $ } from './dom.js';
import { readCanvas, readCtx, drawOriented, video } from './camera.js';
import { pieceMedia, loadMediaFromURL } from './media.js';
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
  //
  // Hue is circular (0-360 wraps), so a plain arithmetic mean is wrong for any
  // colour near the 0°/360° seam — e.g. samples at 355° and 5° should average
  // to ~0°, but hs/n would give ~180°. Average via sin/cos (circular mean)
  // instead. This matters a lot for warm/red-magenta paints (like a ~343°
  // orange), which sit right next to that seam.
  let sinSum = 0, cosSum = 0, ss = 0, vs = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [hh, s, v] = rgb2hsv(data[i], data[i + 1], data[i + 2]);
    if (s > 0.2 && v > 0.15) {
      const rad = hh * Math.PI / 180;
      sinSum += Math.sin(rad); cosSum += Math.cos(rad);
      ss += s; vs += v; n++;
    }
  }
  if (n < 4) { statusEl.textContent = 'Tap missed — too dark or unsaturated, try again'; return; }

  let meanH = Math.atan2(sinSum, cosSum) * 180 / Math.PI;
  if (meanH < 0) meanH += 360;
  const cal = { h: meanH, s: ss / n, v: vs / n };
  state.calibrated[state.calibrating] = cal;
  state.smoothHulls[state.calibrating] = null;
  state.lastCentroid[state.calibrating] = null;
  state.missStreak[state.calibrating] = 0;
  statusEl.textContent =
    `${PIECES[state.calibrating].name} → H=${Math.round(cal.h)}° S=${cal.s.toFixed(2)} V=${cal.v.toFixed(2)}`;
  state.calibrating = -1;
  tapHint.style.display = 'none';
  crosshair.style.display = 'none';
  if (readout) readout.style.display = 'none';
  overlayPanel.classList.add('open');
  buildUI();
}

// Any tap is a user gesture — use it to make sure the iOS camera stream is
// still playing (it can get suspended mid-session). Runs even while calibrating.
function keepCameraLive() {
  if (video.paused) video.play().catch(() => {});
}

// Small floating readout that tracks the crosshair while calibrating, so you
// can see live H/S/V under the cursor before you tap — useful for checking
// whether a piece's colour is stable across the surface (gloss hotspots will
// show up as the reading jumping around as you move) and for sanity-checking
// paints before committing to a tap. Built here rather than in index.html so
// no markup changes are needed; sampled straight from readCtx, which the main
// loop is already redrawing every frame — this adds no extra camera reads.
let readout = null;
function ensureReadout() {
  if (readout) return readout;
  readout = document.createElement('div');
  readout.style.cssText =
    'position:fixed;pointer-events:none;z-index:9999;display:none;' +
    'background:rgba(0,0,0,0.78);color:#fff;font:12px/1.3 monospace;' +
    'padding:3px 7px;border-radius:4px;white-space:nowrap;transform:translate(14px,-28px);';
  document.body.appendChild(readout);
  return readout;
}

function updateReadout(clientX, clientY) {
  const el = ensureReadout();
  const rect = mainCanvas.getBoundingClientRect();
  const scaleX = readCanvas.width  / rect.width;
  const scaleY = readCanvas.height / rect.height;
  const px = Math.round((clientX - rect.left) * scaleX);
  const py = Math.round((clientY - rect.top)  * scaleY);
  if (px < 0 || py < 0 || px >= readCanvas.width || py >= readCanvas.height) {
    el.style.display = 'none';
    return;
  }
  const d = readCtx.getImageData(px, py, 1, 1).data;
  const [hh, s, v] = rgb2hsv(d[0], d[1], d[2]);
  el.textContent = `H${Math.round(hh)}° S${s.toFixed(2)} V${v.toFixed(2)}`;
  el.style.left = clientX + 'px';
  el.style.top  = clientY + 'px';
  el.style.display = 'block';
}

export function wireCalibration() {
  mainCanvas.addEventListener('mousemove', e => {
    if (state.calibrating < 0) return;
    const rect = mainCanvas.getBoundingClientRect();
    crosshair.style.left = (e.clientX - rect.left) + 'px';
    crosshair.style.top  = (e.clientY - rect.top)  + 'px';
    updateReadout(e.clientX, e.clientY);
  });
  mainCanvas.addEventListener('mouseleave', () => {
    if (readout) readout.style.display = 'none';
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
// The schema is a strict superset of the original calibration-only file:
// htol/stol/vtol/minArea and per-piece h/s/v/name are unchanged, so old
// calibration-only JSON files still load fine (missing media/adjust just
// means "leave that piece's media/framing alone"). New fields:
//   media  — { type, url } — ONLY set if the piece's current media has a
//            sourceURL (i.e. it was attached via the 🔗 URL control, or by
//            loading a previous config). Media attached via the local file
//            picker has no URL to reference and is silently omitted here —
//            saveBtn warns below when that happens.
//   adjust — the piece's zoom/rotate/xshift/yshift framing sliders.
function getCalData() {
  return {
    htol: params.htol, stol: params.stol, vtol: params.vtol, minArea: params.minArea,
    pieces: state.calibrated.map((c, i) => {
      if (!c) return null;
      const out = { ...c, name: PIECES[i].name, adjust: { ...state.mediaAdjust[i] } };
      const m = pieceMedia[i];
      if (m && m.sourceURL) out.media = { type: m.type, url: m.sourceURL };
      return out;
    }),
  };
}

// Applies tolerances, colours, and framing synchronously and immediately
// (buildUI reflects them right away), then fetches any referenced media one
// piece at a time. Media runs after and separately so a slow or broken URL
// can't block or fail the fast, important part of the restore. Returns a
// promise that resolves once every media fetch has settled (success or not).
async function applyCalData(data) {
  for (const key of ['htol', 'stol', 'vtol', 'minArea'])
    if (data[key] !== undefined) params[key] = data[key];
  syncSliders();

  if (Array.isArray(data.pieces)) {
    data.pieces.forEach((c, i) => {
      state.calibrated[i] = c ? { h: c.h, s: c.s, v: c.v } : null;
      state.smoothHulls[i] = null;
      state.lastCentroid[i] = null;
      state.missStreak[i] = 0;
      if (c && c.adjust) {
        // merge over defaults rather than replace outright, so a config
        // saved before a slider was added doesn't leave that key undefined
        state.mediaAdjust[i] = Object.fromEntries(
          MEDIA_SLIDERS.map(s => [s.key, c.adjust[s.key] ?? s.def])
        );
      }
    });
  }
  buildUI();

  if (Array.isArray(data.pieces)) {
    for (let i = 0; i < data.pieces.length; i++) {
      const media = data.pieces[i] && data.pieces[i].media;
      if (!media || !media.url) continue;
      statusEl.textContent = `Loading media for ${PIECES[i] ? PIECES[i].name : 'piece ' + (i + 1)}…`;
      try {
        await loadMediaFromURL(i, media.url, buildUI);
      } catch (err) {
        // one bad/unreachable URL shouldn't stop the rest of the config from
        // loading — note it and move on to the next piece.
        statusEl.textContent = `${PIECES[i] ? PIECES[i].name : 'Piece'}: media load failed — ${err.message || err}`;
      }
    }
    statusEl.textContent = 'Config loaded';
  }
}

export function wireSaveLoad() {
  $('saveBtn').onclick = () => {
    const data = getCalData();
    // flag calibrated pieces whose media won't be included — attached via a
    // local file pick, so there's no URL for the saved config to reference.
    const missing = data.pieces
      .map((p, i) => (p && pieceMedia[i] && !pieceMedia[i].sourceURL) ? PIECES[i].name : null)
      .filter(Boolean);

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'tangram-config.json'; a.click();
    URL.revokeObjectURL(url);

    $('calName').textContent = missing.length
      ? `saved ✓ (media not included for: ${missing.join(', ')} — attach via 🔗 URL to include)`
      : 'saved ✓';
  };
  $('loadBtn').onclick = () => $('loadFile').click();
  $('loadFile').onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      let data;
      try {
        data = JSON.parse(ev.target.result);
      } catch (err) {
        statusEl.textContent = 'Failed to parse config file';
        return;
      }
      $('calName').textContent = `loading: ${file.name}…`;
      statusEl.textContent = 'Loading config…';
      applyCalData(data).then(() => {
        $('calName').textContent = `loaded: ${file.name}`;
      });
    };
    reader.readAsText(file);
    e.target.value = '';
  };
  $('clearAllBtn').onclick = () => {
    if (!confirm('Clear all calibrations?')) return;
    state.calibrated = Array(N).fill(null);
    state.smoothHulls = Array(N).fill(null);
    state.lastCentroid = Array(N).fill(null);
    state.missStreak = Array(N).fill(0);
    $('calName').textContent = '';
    buildUI();
  };
}