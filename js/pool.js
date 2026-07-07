// ── pool: the global media asset pool for timeline sequences ──────────────────
// A flat, config-level list of decoded image/gif records that ANY piece's
// `sequence` timeline can index into (see the top-level `assets` array in a
// config, and configIO.js). This is deliberately NOT per-piece:
//
//   • One decode, many users. Two pieces whose timelines both point at index 3
//     share the same decoded record — one GIF frame-timer, both pieces draw
//     whatever frame it's on this rAF, so they animate in lockstep for free.
//   • Config-scoped lifecycle. Unlike pieceMedia[i] — which owns exactly one
//     asset and frees it on a per-piece clear — the pool is rebuilt wholesale
//     when a config loads and freed only as a unit (loadPool disposes the old
//     one first). A single-piece clear must never yank an asset another piece
//     still indexes, so per-piece disposeMedia leaves the pool untouched; a
//     sequence's pieceMedia record holds only its cue list and reaches in here
//     at draw time via poolAsset().
//
// Scope is image + gif only (the two clean, self-contained drawable frames).
// Video (DOM node / audio / play-state) and captions (inline text, per-piece)
// stay out of the pool by design.

import { isGif, loadGif } from './gif.js';

// Each entry (or null for a slot that failed/was empty):
//   { type:'image'|'gif', el, url, stop? }
//     el   — a drawImage-able source (Image, or a gif's offscreen canvas)
//     url  — the source URL, kept so the pool round-trips back into a config
//     stop — gif frame-timer halt fn (images have none)
let mediaPool = [];

// Fetch + decode one URL into a pool record, mirroring media.js's own paths:
// gifs go through loadGif (self-animating offscreen canvas), static images go
// bytes → data URL → Image so the draw source is origin-clean (no canvas taint
// even for cross-origin hosts, exactly like the per-piece image path).
async function decodeAssetFromURL(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const name = decodeURIComponent((url.split('/').pop() || 'asset').split('?')[0]) || 'asset';
  const file = new File([blob], name, { type: blob.type || '' });

  if (isGif(file)) {
    const { el, stop } = await loadGif(file);
    return { type: 'gif', el, url, stop };
  }

  const dataURL = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result);
    r.onerror = () => reject(new Error('could not read image bytes'));
    r.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload  = () => resolve(im);
    im.onerror = () => reject(new Error('image decode failed'));
    im.src = dataURL;
  });
  return { type: 'image', el: img, url };
}

// Halt every gif timer and empty the pool. Called on reload (by loadPool) so
// old assets don't leak their frame-compositing timers.
export function disposePool() {
  for (const a of mediaPool) if (a && a.stop) a.stop();
  mediaPool = [];
}

// Decode a config's top-level `assets` list into the pool, replacing whatever
// was there. Entries may be { type?, url } objects or bare URL strings. Decode
// runs in parallel; a bad/unreachable URL resolves to a null slot rather than
// sinking the whole pool — its indices simply render nothing (the piece falls
// through to its colour wash), matching configIO's per-piece media tolerance.
// Slots stay index-aligned with the input so timeline indices remain valid.
// Returns the count that decoded successfully.
export async function loadPool(assets) {
  disposePool();
  if (!Array.isArray(assets)) return 0;
  const out = new Array(assets.length).fill(null);
  await Promise.all(assets.map(async (a, idx) => {
    const url = a && (typeof a === 'string' ? a : a.url);
    if (!url) return;
    try { out[idx] = await decodeAssetFromURL(url); }
    catch (err) { console.warn(`[pool] asset ${idx} (${url}) failed:`, err.message || err); }
  }));
  mediaPool = out;
  return out.filter(Boolean).length;
}

// Serialize the pool back to a config `assets` list, index-aligned. Failed/empty
// slots round-trip as null so every piece's timeline indices keep pointing at
// the same assets they did before the save.
export function serializePool() {
  return mediaPool.map(a => (a ? { type: a.type, url: a.url } : null));
}

// Resolve a timeline index to its pool record, or null if the index is null /
// out of range / a failed slot. Uses `== null` so index 0 is a valid lookup.
export function poolAsset(index) {
  if (index == null || index < 0 || index >= mediaPool.length) return null;
  return mediaPool[index];
}

// Is the pool non-empty? Lets configIO omit an empty `assets:[]` from saves.
export function poolSize() {
  return mediaPool.filter(Boolean).length;
}