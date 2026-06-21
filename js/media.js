// ── piece media ───────────────────────────────────────────────────────────────
// Per-piece image / video / captions overlays and the iOS-safe loading paths.
// Caption parsing/drawing lives in caption.js; this file just attaches the cues.

import { N, PIECES } from './config.js';
import { statusEl } from './dom.js';
import { state } from './state.js';
import { parseCues } from './caption.js';

// per piece: { type:'image'|'video'|'captions', el, url, name, cues? } or null
export const pieceMedia = Array(N).fill(null);

export function disposeMedia(i) {
  const m = pieceMedia[i];
  if (!m) return;
  if (m.url) URL.revokeObjectURL(m.url);
  if (m.type === 'video') { try { m.el.pause(); m.el.remove(); } catch (e) {} }
  pieceMedia[i] = null;
}

// Load a picked file onto piece i. `refresh` (buildUI) re-renders the row.
export function loadMediaFile(i, file, refresh) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const isCaptions = ext === 'json' || file.type === 'application/json';
  const isVideo = !isCaptions &&
    (file.type.startsWith('video/') || ['mov','mp4','m4v','webm','ogv','3gp','avi'].includes(ext));

  const setMedia = (type, el, url) => {
    disposeMedia(i);
    pieceMedia[i] = { type, el, url, name: file.name };
    statusEl.textContent = `${PIECES[i].name}: ${type} attached`;
    refresh();
  };

  // ── captions: parse to time-sorted cues; reset this piece's clock ──
  if (isCaptions) {
    const reader = new FileReader();
    reader.onload = () => {
      let cues;
      try { cues = parseCues(JSON.parse(reader.result)); }
      catch (e) { statusEl.textContent = `${PIECES[i].name}: couldn't parse captions JSON`; return; }
      if (!cues.length) { statusEl.textContent = `${PIECES[i].name}: no caption cues in that JSON`; return; }
      disposeMedia(i);
      pieceMedia[i] = { type: 'captions', el: null, url: null, name: file.name, cues };
      state.captionElapsed[i] = 0;            // fresh attach → play from the top
      statusEl.textContent = `${PIECES[i].name}: captions attached (${cues.length} cues)`;
      refresh();
    };
    reader.onerror = () => { statusEl.textContent = 'Could not read that file'; };
    reader.readAsText(file);
    return;
  }

  // ── video: blob via <source> child, kept tiny + on-screen (iOS-safe) ──
  if (isVideo) {
    const url = URL.createObjectURL(file);
    const vid = document.createElement('video');
    vid.loop = true; vid.muted = true; vid.playsInline = true;
    vid.setAttribute('playsinline', '');
    vid.setAttribute('webkit-playsinline', '');
    const srcEl = document.createElement('source');
    srcEl.src = url; srcEl.type = file.type || 'video/mp4';
    vid.appendChild(srcEl);
    // iOS won't decode a hidden/detached video — keep it tiny but on-screen.
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
    return;
  }

  // ── image: data URL (origin-independent; dodges Safari blob-into-<img> quirks) ──
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload  = () => setMedia('image', img, null);
    img.onerror = () => { statusEl.textContent = 'Decoded but failed to render — try a JPG or PNG'; };
    img.src = reader.result;
  };
  reader.onerror = () => { statusEl.textContent = 'Could not read that file'; };
  reader.readAsDataURL(file);
}