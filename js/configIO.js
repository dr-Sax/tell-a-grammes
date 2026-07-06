// ── configIO: save / load / export a whole setup ───────────────────────────────
// Tolerances, per-piece colour calibration, media references, and framing —
// serialized to/from JSON. Tap-to-sample calibration itself lives in
// calibrate.js; this module only persists the result.

import { PIECES, N, params, MEDIA_SLIDERS } from './config.js';
import { state } from './state.js';
import { statusEl, $ } from './dom.js';
import { pieceMedia, loadMediaFromURL, attachCaptionCues } from './media.js';
import { buildUI, syncSliders } from './ui.js';

// The schema is a strict superset of the original calibration-only file:
// htol/stol/vtol/minArea and per-piece h/s/v/name are unchanged, so old
// calibration-only JSON files still load fine (missing media/adjust just
// means "leave that piece's media/framing alone"). New fields:
//   media  — { type, url, link? } for images/video/gifs — url is ONLY set if
//            the piece's current media has a sourceURL (i.e. it was attached
//            via the 🔗 URL control, or by loading a previous config). Media
//            attached via the local file picker has no URL to reference and
//            is silently omitted here — saveBtn warns below when that
//            happens. Captions are the exception: { type:'caption', cues,
//            link? } — cues are small text, so they're always embedded
//            inline regardless of how they were attached, rather than
//            requiring a hosted URL like binary media does. `link`, if set,
//            is a separate click-through URL (see the ↗ link button in
//            ui.js) — it can point anywhere, unrelated to the asset itself.
//   adjust — the piece's zoom/rotate/xshift/yshift framing sliders.
function getCalData() {
  return {
    htol: params.htol, stol: params.stol, vtol: params.vtol, minArea: params.minArea,
    pieces: PIECES.map((_, i) => {
      const c = state.calibrated[i];
      const m = pieceMedia[i];
      const isCaption = m && m.type === 'caption' && m.cues && m.cues.length;
      const hasMediaURL = m && m.sourceURL && !isCaption;
      const adjustTouched = MEDIA_SLIDERS.some(s => state.mediaAdjust[i][s.key] !== s.def);
      if (!c && !isCaption && !hasMediaURL && !adjustTouched) return null;

      const out = { name: PIECES[i].name, adjust: { ...state.mediaAdjust[i] } };
      if (c) Object.assign(out, { h: c.h, s: c.s, v: c.v });
      if (isCaption) {
        out.media = { type: 'caption', cues: Object.fromEntries(m.cues.map(cue => [String(cue.t), cue.text])) };
        if (m.link) out.media.link = m.link;
      } else if (hasMediaURL) {
        out.media = { type: m.type, url: m.sourceURL };
        if (m.link) out.media.link = m.link;
      }
      return out;
    }),
  };
}

async function applyCalData(data) {
  for (const key of ['htol', 'stol', 'vtol', 'minArea'])
    if (data[key] !== undefined) params[key] = data[key];
  syncSliders();

  if (Array.isArray(data.pieces)) {
    data.pieces.forEach((c, i) => {
      // a piece entry may now exist for media/framing alone, without colour
      // data (see getCalData) — only treat it as calibrated if h/s/v are present.
      state.calibrated[i] = (c && c.h !== undefined) ? { h: c.h, s: c.s, v: c.v } : null;
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
      if (!media) continue;
      try {
        if (media.type === 'caption' && media.cues) {
          // inline cues — synchronous, no network involved
          attachCaptionCues(i, media.cues, buildUI);
        } else if (media.url) {
          statusEl.textContent = `Loading media for ${PIECES[i] ? PIECES[i].name : 'piece ' + (i + 1)}…`;
          await loadMediaFromURL(i, media.url, buildUI, {
            start: media.start, end: media.end, 
            speed: media.speed, volume: media.volume
          });
        } else {
          continue; // nothing usable for this piece
        }
        if (media.link) pieceMedia[i].link = media.link;
      } catch (err) {
        // one bad/unreachable URL (or malformed inline cues) shouldn't stop
        // the rest of the config from loading — note it and move on.
        statusEl.textContent = `${PIECES[i] ? PIECES[i].name : 'Piece'}: media load failed — ${err.message || err}`;
      }
    }
    statusEl.textContent = 'Config loaded';
  }
}

export function wireSaveLoad() {
  $('saveBtn').onclick = () => {
    const data = getCalData();
    const missing = PIECES
      .map((p, i) => (pieceMedia[i] && !pieceMedia[i].sourceURL) ? p.name : null)
      .filter(Boolean);

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'tangram-config.json'; a.click();
    URL.revokeObjectURL(url);

    if (missing.length) {
      $('calName').textContent = 'saved ✓ (media excluded — see status)';
      statusEl.textContent = `Saved, but media for ${missing.join(', ')} won't load from this file — ` +
        `it was attached locally, not via 🔗 URL. Re-attach via 🔗 to include it next time.`;
    } else {
      $('calName').textContent = 'saved ✓';
    }
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

export async function loadConfigFromURL(url) {
  statusEl.textContent = 'Loading config from URL…';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    await applyCalData(data);
    $('calName').textContent = 'loaded from URL';
  } catch (err) {
    statusEl.textContent = `Failed to load config from URL — ${err.message || err}`;
  }
}