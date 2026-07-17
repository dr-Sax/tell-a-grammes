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
//
// iOS gesture handling: playback is only allowed inside a user gesture, per
// ELEMENT — once an element has played during a gesture, later programmatic
// play() on that same element is permitted. So there is exactly ONE Audio
// element for the module's whole lifetime; attach/detach swap its src, never
// the element. If the start gesture (Start camera) arrives before the config
// has attached the real src — easy on mobile, where the config fetch races
// the tap — startAudio() plays a ~silent inline wav to bless the element
// inside the gesture and remembers the request; attachAudio() then starts the
// real file the moment it lands, no second tap needed.

import { state } from './state.js';
import { statusEl } from './dom.js';

// Shortest valid silent wav, inline so priming needs no network.
const SILENT = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA';

const el = new Audio();
el.preload = 'auto';

let srcURL = null;
let pendingStart = false;
let retryArmed = false;

// Surface media errors in the status line — on the phone there's no console,
// and "no sound" is otherwise indistinguishable from "blocked" vs "bad URL"
// vs "server can't stream". error.code 4 (SRC_NOT_SUPPORTED) on a URL that
// plays on desktop usually means the host isn't answering HTTP Range
// requests, which iOS requires for streaming longer files.
el.addEventListener('error', () => {
  if (!srcURL) return; // ignore the priming wav / detached element
  const codes = { 1: 'aborted', 2: 'network error', 3: 'decode failed', 4: 'source not supported' };
  const c = el.error && el.error.code;
  statusEl.textContent = `Audio failed: ${codes[c] || 'unknown'} — ${srcURL.split('/').pop()}`;
});
el.addEventListener('stalled', () => {
  if (srcURL && el.paused) statusEl.textContent = 'Audio stalled while buffering…';
});

function armRetry() {
  if (retryArmed) return;
  retryArmed = true;
  window.addEventListener('pointerdown', () => {
    retryArmed = false;
    if (srcURL) el.play().catch(() => {});
  }, { once: true });
}

export function attachAudio(url, { loop = true } = {}) {
  el.pause();
  el.loop = loop;
  el.src = url;
  el.load();
  srcURL = url;
  if (pendingStart) {
    // the start gesture already happened and blessed this element — play now
    pendingStart = false;
    el.play().catch(armRetry);
  }
}

export function disposeAudio() {
  el.pause();
  el.removeAttribute('src');
  el.load();
  srcURL = null;
  pendingStart = false;
}

// Called synchronously inside a user gesture (Start camera, the 🔗 attach
// prompt). Three cases: real src present → play (retry-on-tap if blocked);
// no src yet → prime with the silent wav inside this gesture and flag the
// start for attachAudio; nothing attached and nothing pending → still prime,
// it's free and keeps the element blessed for a later config load.
export function startAudio() {
  if (srcURL) {
    el.play().catch(armRetry);
    return;
  }
  pendingStart = true;
  el.src = SILENT;
  el.loop = false;
  el.play().catch(() => {});
}

export function pauseAudio() { el.pause(); }
export function hasAudio()   { return !!srcURL; }
export function audioURL()   { return srcURL; }
export function audioLoop()  { return srcURL ? el.loop : true; }
export function audioActive() { return !!srcURL && !el.paused && !el.ended; }

// The clock a piece's timed media should read this frame. `wrap` tells the
// timeline lookup whether to apply its own loop modulo (only when the piece
// is on its private clock — see module comment).
export function pieceClock(i) {
  return audioActive()
    ? { t: el.currentTime, wrap: false }
    : { t: state.captionElapsed[i], wrap: true };
}