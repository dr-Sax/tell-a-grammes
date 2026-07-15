// ── configIO: save / load / export a whole setup ───────────────────────────────
// Tolerances, per-piece colour calibration, media references, and framing —
// serialized to/from JSON. Tap-to-sample calibration itself lives in
// calibrate.js; this module only persists the result.

import { PIECES, N, params, MEDIA_SLIDERS } from './config.js';
import { state } from './state.js';
import { statusEl, $ } from './dom.js';
import { pieceMedia, loadMediaFromURL, attachCaptionCues, attachSequence } from './media.js';
import { loadPool, serializePool, disposePool, poolSize } from './pool.js';
import { buildUI, syncSliders } from './ui.js';

// A piece's colour is saved as the sampled r/g/b triple — the exact record
// calibrate.js stores and detect.js claims clusters with, so a config
// round-trips detection losslessly. (Earlier files saved h/s/v instead; those
// fields are no longer read, so pre-RGB configs load with their media and
// framing intact but their colours uncalibrated — one re-tap per colour and a
// re-save brings such a file forward.) Missing media/adjust on a piece just
// means "leave that piece's media/framing alone".
//
// Top-level (new):
//   assets — a flat pool of image/gif references [{ type, url }, …] that any
//            piece's `sequence` timeline indexes into. Config-level rather than
//            per-piece so one decoded asset can be shared across pieces (see
//            pool.js). Omitted entirely when no sequences are in use.
//
// Per-piece new fields:
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
//            Sequences are the other inline type: { type:'sequence',
//            timeline, link? }, where timeline is {"<seconds>": <assetIndex>}
//            pointing into the top-level `assets` pool. Like captions the
//            timeline is small text embedded inline; the binary it references
//            lives once in the pool, not re-embedded per piece.
//   adjust — the piece's zoom/rotate/xshift/yshift framing sliders. For a
//            sequence these apply to whichever pool asset is active, so every
//            frame in the sequence shares this one piece's framing.
function getCalData() {
  const data = { minArea: params.minArea };
  // Only carry the pool when something's actually in it, so calibration-only /
  // caption-only saves stay as clean as they were before sequences existed.
  if (poolSize()) data.assets = serializePool();

  data.pieces = PIECES.map((_, i) => {
    const c = state.calibrated[i];
    const m = pieceMedia[i];
    const isCaption  = m && m.type === 'caption'  && m.cues && m.cues.length;
    const isSequence = m && m.type === 'sequence' && m.cues && m.cues.length;
    const hasMediaURL = m && m.sourceURL && !isCaption && !isSequence;
    const adjustTouched = MEDIA_SLIDERS.some(s => state.mediaAdjust[i][s.key] !== s.def);
    if (!c && !isCaption && !isSequence && !hasMediaURL && !adjustTouched) return null;

    const out = { name: PIECES[i].name, adjust: { ...state.mediaAdjust[i] } };
    if (c) Object.assign(out, { r: c.r, g: c.g, b: c.b });
    if (isCaption) {
      out.media = { type: 'caption', cues: Object.fromEntries(m.cues.map(cue => [String(cue.t), cue.value])) };
      if (m.link) out.media.link = m.link;
    } else if (isSequence) {
      out.media = { type: 'sequence', timeline: Object.fromEntries(m.cues.map(cue => [String(cue.t), cue.value])) };
      if (m.link) out.media.link = m.link;
    } else if (hasMediaURL) {
      out.media = { type: m.type, url: m.sourceURL };
      if (m.link) out.media.link = m.link;
    }
    return out;
  });

  return data;
}

async function applyCalData(data) {
  if (data.minArea !== undefined) params.minArea = data.minArea;
  syncSliders();

  if (Array.isArray(data.pieces)) {
    data.pieces.forEach((c, i) => {
      // a piece entry may exist for media/framing alone, without colour data
      // (see getCalData) — only treat it as calibrated if r/g/b are present.
      state.calibrated[i] = (c && c.r !== undefined) ? { r: c.r, g: c.g, b: c.b } : null;
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

  // Rebuild the shared asset pool first (config-scoped: disposes the previous
  // one, decodes this config's assets in parallel) so sequence indices resolve
  // as soon as pieces attach. Independent of whether any piece uses sequences —
  // an absent `assets` just empties the pool.
  if (data.assets !== undefined) {
    statusEl.textContent = 'Loading sequence assets…';
    const n = await loadPool(data.assets);
    if (n) statusEl.textContent = `Loaded ${n} sequence asset${n === 1 ? '' : 's'}`;
  } else {
    disposePool();
  }

  if (Array.isArray(data.pieces)) {
    for (let i = 0; i < data.pieces.length; i++) {
      const media = data.pieces[i] && data.pieces[i].media;
      if (!media) continue;
      try {
        if (media.type === 'caption' && media.cues) {
          // inline cues — synchronous, no network involved
          attachCaptionCues(i, media.cues, buildUI);
        } else if (media.type === 'sequence' && media.timeline) {
          // inline timeline of pool indices — also synchronous; the binary it
          // points at was already decoded into the pool above.
          attachSequence(i, media.timeline, buildUI);
        } else if (media.url) {
          statusEl.textContent = `Loading media for ${PIECES[i] ? PIECES[i].name : 'piece ' + (i + 1)}…`;
          await loadMediaFromURL(i, media.url, buildUI);
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