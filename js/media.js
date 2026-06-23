// ── piece media ───────────────────────────────────────────────────────────────
// Per-piece image/video overlays and the iOS-safe file-loading paths.

import { N, PIECES } from './config.js';
import { statusEl } from './dom.js';
import { isGif, loadGif } from './gif.js';

// per piece: { type:'image'|'video'|'gif', el, url, name } or null
export const pieceMedia = Array(N).fill(null);

export function disposeMedia(i) {
  const m = pieceMedia[i];
  if (!m) return;
  if (m.url) URL.revokeObjectURL(m.url);
  if (m.type === 'video') { try { m.el.pause(); m.el.remove(); } catch (e) {} }
  pieceMedia[i] = null;
}

// Load a picked file onto piece i. `refresh` is invoked (e.g. buildUI) whenever
// the attachment changes, so the UI can re-render its thumbnail.
export function loadMediaFile(i, file, refresh) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const isVideo = file.type.startsWith('video/') ||
                  ['mov', 'mp4', 'm4v', 'webm', 'ogv', '3gp', 'avi'].includes(ext);

  const setMedia = (type, el, url) => {
    disposeMedia(i);
    pieceMedia[i] = { type, el, url, name: file.name };
    statusEl.textContent = `${PIECES[i].name}: ${type} attached`;
    refresh();
  };

  // GIFs: delegate to the gif module
  if (isGif(file)) {
    loadGif(file)
      .then(({ el, type }) => setMedia(type, el, null))
      .catch(err => {
        statusEl.textContent = `GIF failed: ${err.message}`;
      });
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
    // Static images: data URL (origin-independent; dodges Safari's blob-into-<img>
    // quirks and works inside sandboxed iframes).
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload  = () => setMedia('image', img, null);
      img.onerror = () => { statusEl.textContent = 'Decoded but failed to render — try a JPG, PNG, or GIF'; };
      img.src = reader.result;   // data:image/...;base64,...
    };
    reader.onerror = () => { statusEl.textContent = 'Could not read that file'; };
    reader.readAsDataURL(file);
  }
}