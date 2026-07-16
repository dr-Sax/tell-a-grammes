// ── audio: global master clock ────────────────────────────────────────────────
// One hosted audio file whose currentTime, while playing, overrides every
// piece's per-detection clock (state.captionElapsed[i]) so captions and
// sequences across all pieces stay locked to the soundtrack. When no audio is
// attached (or it's blocked/paused), pieces fall back to their independent
// occlusion-tolerant clocks, exactly as before.
//
// Looping: the audio element itself is the loop authority (el.loop). While it
// drives, timeline lookups must NOT apply their own modulo — a cue period that
// differs from the mp3's duration by even half a second would drift a little
// further out of sync every cycle. pieceClock() returns wrap:false for that
// reason, and render.js/caption.js pass it through to timelineValueAt.

import { state } from './state.js';

let el = null;
let srcURL = null;
let retryArmed = false;

export function attachAudio(url, { loop = true } = {}) {
  disposeAudio();
  el = new Audio();
  el.preload = 'auto';
  el.loop = loop;
  el.src = url;
  srcURL = url;
}

export function disposeAudio() {
  if (el) { el.pause(); el.removeAttribute('src'); el.load(); }
  el = null;
  srcURL = null;
}

// Attempt playback. iOS only allows this inside a user gesture, and the
// activation is transient — it can expire across an await. Callers therefore
// invoke this synchronously at the top of their handlers (see startBtn in
// main.js). If playback is still blocked (e.g. audio arrived via a config
// loaded after the camera was already running), arm a one-time pointerdown
// retry so the next tap anywhere starts it.
export function startAudio() {
  if (!el) return;
  el.play().catch(() => {
    if (retryArmed) return;
    retryArmed = true;
    window.addEventListener('pointerdown', () => {
      retryArmed = false;
      if (el) el.play().catch(() => {});
    }, { once: true });
  });
}

export function pauseAudio() { if (el) el.pause(); }
export function hasAudio()   { return !!el; }
export function audioURL()   { return srcURL; }
export function audioLoop()  { return el ? el.loop : true; }
export function audioActive() { return !!el && !el.paused && !el.ended; }

// The clock a piece's timed media should read this frame. `wrap` tells the
// timeline lookup whether to apply its own loop modulo (only when the piece
// is on its private clock — see module comment).
export function pieceClock(i) {
  return audioActive()
    ? { t: el.currentTime, wrap: false }
    : { t: state.captionElapsed[i], wrap: true };
}