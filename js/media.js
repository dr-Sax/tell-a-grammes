// ── piece media ───────────────────────────────────────────────────────────────
// Per-piece image / video / captions overlays and the iOS-safe loading paths.

import { N, PIECES } from './config.js';
import { statusEl } from './dom.js';
import { state } from './state.js';

// per piece: { type:'image'|'video'|'captions', el, url, name, cues? } or null
//   image/video → el is the <img>/<video>; url is the object URL (video only)
//   captions    → el/url are null; cues is a time-sorted [{ t, text }] array
export const pieceMedia = Array(N).fill(null);

export function disposeMedia(i) {
  const m = pieceMedia[i];
  if (!m) return;
  if (m.url) URL.revokeObjectURL(m.url);
  if (m.type === 'video') { try { m.el.pause(); m.el.remove(); } catch (e) {} }
  pieceMedia[i] = null;
}

// Parse the flat {"<seconds>": "<word or phrase>"} caption dict into a
// time-sorted array [{ t, text }]. JSON object key order is not guaranteed
// across producers, so sorting by t is required, not optional.
function parseCues(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const cues = [];
  for (const key of Object.keys(raw)) {
    const t = parseFloat(key);
    if (!Number.isFinite(t)) continue;
    cues.push({ t, text: String(raw[key]) });
  }
  cues.sort((a, b) => a.t - b.t);
  return cues;
}

// Active word for a captions attachment at `elapsed` seconds: the last cue
// whose timestamp is <= elapsed (binary search). Returns null before the first
// cue's timestamp. There are no end times by design — the final word holds
// forever once reached, and every moment after the first cue has a word.
export function activeCaption(media, elapsed) {
  if (!media || media.type !== 'captions') return null;
  const cues = media.cues;
  let lo = 0, hi = cues.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].t <= elapsed) { ans = mid; lo = mid + 1; }
    else                        { hi = mid - 1; }
  }
  return ans >= 0 ? cues[ans].text : null;
}

// Load a picked file onto piece i. `refresh` is invoked (e.g. buildUI) whenever
// the attachment changes, so the UI can re-render its thumbnail.
export function loadMediaFile(i, file, refresh) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const isCaptions = ext === 'json' || file.type === 'application/json';
  const isVideo = !isCaptions && (
                  file.type.startsWith('video/') ||
                  ['mov', 'mp4', 'm4v', 'webm', 'ogv', '3gp', 'avi'].includes(ext));

  const setMedia = (type, el, url) => {
    disposeMedia(i);
    pieceMedia[i] = { type, el, url, name: file.name };
    statusEl.textContent = `${PIECES[i].name}: ${type} attached`;
    refresh();
  };

  if (isCaptions) {
    // Captions: read as text, parse to time-sorted cues. No object URL, no
    // media element — just the cue list. Attaching resets this piece's caption
    // clock so playback starts from the top of the track.
    const reader = new FileReader();
    reader.onload = () => {
      let cues;
      try { cues = parseCues(JSON.parse(reader.result)); }
      catch (e) { statusEl.textContent = `${PIECES[i].name}: couldn't parse captions JSON`; return; }
      if (!cues.length) { statusEl.textContent = `${PIECES[i].name}: no caption cues in that JSON`; return; }
      disposeMedia(i);
      pieceMedia[i] = { type: 'captions', el: null, url: null, name: file.name, cues };
      state.captionElapsed[i] = 0;
      statusEl.textContent = `${PIECES[i].name}: captions attached (${cues.length} cues)`;
      refresh();
    };
    reader.onerror = () => { statusEl.textContent = 'Could not read that file'; };
    reader.readAsText(file);
    return;
  }

  if (isVideo) {
    // blob: URL attached via a <source> child — the iOS-safe path (src-attribute
    // blob URLs are flaky on Safari).
    const url = URL.createObjectURL(file);
    const vid = document.createElement('video');
    vid.loop = true; vid.muted = true; vid.playsInline = true;
    vid.setAttribute('playsinline', '');
    vid.setAttribute('webkit-playsinline', '');
    const srcEl = document.createElement('source');
    srcEl.src = url; srcEl.type = file.type || 'video/mp4';
    vid.appendChild(srcEl);
    // iOS won't decode frames from a detached/hidden video — keep it in the DOM,
    // on-screen but effectively invisible.
    vid.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(vid);
    vid.load();
    const start = () => vid.play().then(() => setMedia('video', vid, url))
      .catch(() => {
        setMedia('video', vid, url);
        statusEl.textContent = `${PIECES[i].name}: tap the video area once to start playback`;
      });
    if (vid.readyState >= 2) start();
    else vid.addEventListener('loadeddata', start, { once: true });
    vid.onerror = () => {
      statusEl.textContent = 'Video failed — if testing in an in-app preview, open the file in Safari instead';
      URL.revokeObjectURL(url);
    };
  } else {
    // Images: data URL (origin-independent; dodges Safari's blob-into-<img>
    // quirks and works inside sandboxed iframes).
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload  = () => setMedia('image', img, null);
      img.onerror = () => { statusEl.textContent = 'Decoded but failed to render — try a JPG or PNG'; };
      img.src = reader.result;   // data:image/...;base64,...
    };
    reader.onerror = () => { statusEl.textContent = 'Could not read that file'; };
    reader.readAsDataURL(file);
  }
}