// ── piece media ───────────────────────────────────────────────────────────────
// Per-piece image/video/gif/caption overlays and the iOS-safe file-loading paths.

import { N, PIECES } from './config.js';
import { state } from './state.js';
import { statusEl } from './dom.js';
import { isGif, loadGif } from './gif.js';
import { parseCues } from './caption.js';
import { parseTimeline } from './timeline.js';

// per piece: { type:'image'|'video'|'gif'|'caption', el, url, name, sourceURL,
//              link, stop?, cues? } or null
//   el        — a drawImage-able source (Image, video, or gif's offscreen canvas); none for captions
//   url       — object URL to revoke on dispose (video only; null otherwise)
//   sourceURL — the remote URL this media was fetched from, if it was
//               (loadMediaFromURL sets this; local file picks leave it null).
//               This is what lets a saved config re-reference the asset by
//               URL instead of needing to re-embed or re-upload it — see
//               getCalData() in calibration.js.
//   link      — optional click-through URL, unrelated to the asset itself —
//               set via the ↗ button in ui.js, opened on tap by links.js.
//   stop      — timer-halt fn (gif only; stops frame compositing on dispose)
//   cues      — time-sorted [{ t, text }] (caption only)
export const pieceMedia = Array(N).fill(null);

export function disposeMedia(i) {
  const m = pieceMedia[i];
  if (!m) return;
  if (m.stop) m.stop();                                   // halt gif frame timer
  if (m.url) URL.revokeObjectURL(m.url);
  if (m.type === 'video') { try { m.el.pause(); m.el.remove(); } catch (e) {} }
  pieceMedia[i] = null;
}

function attachBlob(i, file, refresh, sourceURL = null) {
  return new Promise((resolve, reject) => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const isVideo = file.type.startsWith('video/') ||
                    ['mov', 'mp4', 'm4v', 'webm', 'ogv', '3gp', 'avi'].includes(ext);
    const isCaption = file.type === 'application/json' || ext === 'json';

    // `extra` carries type-specific fields (gif's stop fn, caption's cues) onto the record.
    const setMedia = (type, el, url, extra = {}) => {
      disposeMedia(i);
      pieceMedia[i] = { type, el, url, name: file.name, sourceURL, ...extra };
      statusEl.textContent = `${PIECES[i].name}: ${type} attached`;
      refresh();
      resolve();
    };
    const fail = msg => { statusEl.textContent = msg; reject(new Error(msg)); };

    // Captions: a JSON cue file { "<seconds>": "<word>" }. No frame — just the
    // parsed cues. Reset this piece's caption clock so playback starts at the
    // first cue; the clock then advances only on detected frames (see main.js).
    if (isCaption) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const cues = parseCues(JSON.parse(reader.result));
          if (!cues.length) { fail('No valid cues in that JSON'); return; }
          setMedia('caption', null, null, { cues });
          state.captionElapsed[i] = 0;
        } catch (err) {
          fail('Failed to parse caption JSON');
        }
      };
      reader.onerror = () => fail('Could not read that file');
      reader.readAsText(file);
      return;
    }

    // GIFs: decode + animate via the gif module (returns an offscreen canvas).
    if (isGif(file)) {
      loadGif(file)
        .then(({ el, stop }) => setMedia('gif', el, null, { stop }))
        .catch(err => fail(`GIF failed: ${err.message || err}`));
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
        URL.revokeObjectURL(url);
        fail('Video failed — if testing in an in-app preview, open the file in Safari instead');
      };
    } else {
      // Static images: data URL (origin-independent; dodges Safari's blob-into-<img>
      // quirks and works inside sandboxed iframes).
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload  = () => setMedia('image', img, null);
        img.onerror = () => fail('Decoded but failed to render — try a JPG, PNG, or GIF');
        img.src = reader.result;   // data:image/...;base64,...
      };
      reader.onerror = () => fail('Could not read that file');
      reader.readAsDataURL(file);
    }
  });
}

export function loadMediaFile(i, file, refresh) {
  attachBlob(i, file, refresh, null).catch(() => {});
}

export async function loadMediaFromURL(i, url, refresh) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const name = decodeURIComponent((url.split('/').pop() || 'asset').split('?')[0]) || 'asset';
  const file = new File([blob], name, { type: blob.type || '' });
  await attachBlob(i, file, refresh, url);
}
export function attachCaptionCues(i, cuesRaw, refresh) {
  const cues = parseCues(cuesRaw);
  if (!cues.length) throw new Error('No valid cues in inline caption data');
  disposeMedia(i);
  pieceMedia[i] = { type: 'caption', el: null, url: null, name: 'inline captions', sourceURL: null, link: null, cues };
  state.captionElapsed[i] = 0;
  statusEl.textContent = `${PIECES[i].name}: caption attached`;
  if (refresh) refresh();
}

// A `sequence` piece: a timeline of { t → asset index } into the global media
// pool (pool.js), authored in config as {"<seconds>": <index>}. The record
// itself is featherweight — no `el`, no `url`, no `stop` — it just carries the
// cue list and reaches into the pool at draw time (render.js). That's exactly
// why disposeMedia needs no special case for it: with nothing of its own to
// free, clearing a sequence piece can't touch a pool asset another piece still
// uses. The clock is state.captionElapsed[i] (shared with captions, advanced in
// main.js only on detected frames), reset here so playback starts at cue zero.
export function attachSequence(i, timelineRaw, refresh) {
  const cues = parseTimeline(timelineRaw, v => parseInt(v, 10))
                 .filter(c => Number.isFinite(c.value));
  if (!cues.length) throw new Error('No valid timeline cues in sequence');
  disposeMedia(i);
  pieceMedia[i] = { type: 'sequence', el: null, url: null, name: 'sequence', sourceURL: null, link: null, cues };
  state.captionElapsed[i] = 0;
  statusEl.textContent = `${PIECES[i].name}: sequence attached (${cues.length} cues)`;
  if (refresh) refresh();
}