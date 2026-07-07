// ── audio: the global master-clock audio track ────────────────────────────────
// One <audio> element for the WHOLE config — not attached to any piece. When a
// config supplies a top-level "audio" URL, that track becomes the master clock:
// render.js reads getAudioTime() for every timed piece (captions AND sequences),
// so they all advance in lockstep with the song and loop with it. There is no
// per-piece audio by design — a single track keeps every piece on one timeline.
//
// Authoring: a top-level "audio": "https://…/song.mp3" in a config JSON (see
// configIO.js). No UI button for it yet; hand-authored in the file.
//
// Autoplay: the track is UNMUTED (that's the whole point), so every browser
// blocks it until a user gesture — unlike the muted piece videos, which
// autoplay freely. startAudio() is called from the camera-start click (a real
// gesture) and from any later canvas tap (calibrate.js), and is idempotent, so
// whichever of {camera start, config load} happens second actually kicks
// playback off, and a stray blocked attempt is retried on the next tap.

import { statusEl } from './dom.js';

let audioEl = null;    // the single global <audio>, or null when no track
let sourceURL = null;  // URL it was built from — round-trips back into a config
let wantPlay = false;  // a user gesture has authorized audio; play as soon as we can

// Try to start playback. No-op unless we have BOTH a track and a gesture that
// authorized audio (wantPlay). Safe to call as often as we like.
function tryPlay() {
  if (!audioEl || !wantPlay) return;
  const p = audioEl.play();
  if (p && p.catch) p.catch(() => {
    // still blocked (gesture token expired across an await, or interrupted) —
    // a later canvas tap calls startAudio() again and retries within a fresh
    // gesture, so just nudge the user.
    statusEl.textContent = 'Tap the view once to start audio';
  });
}

// Called from the camera-start click and from any canvas tap (the user
// gestures). Records that audio is allowed, then plays if a track is loaded.
export function startAudio() {
  wantPlay = true;
  tryPlay();
}

// Load a config's global track, replacing any previous one. `loop` is on so the
// audio itself is the sole wrap authority (timelineValueAt must not re-wrap when
// this is active — see render.js). A bad/unreachable URL is tolerated: the track
// just never plays and getAudioTime() stays 0, so the config still loads and the
// pieces sit at cue zero — same forgiveness as a bad asset-pool entry.
export function loadAudio(url) {
  disposeAudio();
  if (!url) return;
  sourceURL = url;
  audioEl = document.createElement('audio');
  audioEl.loop = true;
  audioEl.preload = 'auto';
  audioEl.setAttribute('playsinline', '');
  // keep it in the DOM, tiny and invisible — mirrors the video elements' iOS
  // treatment (Safari won't reliably drive a detached media element).
  audioEl.style.cssText =
    'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1';
  audioEl.src = url;   // plain https URL — src attribute is fine (blob-only is the flaky case)
  audioEl.addEventListener('error', () => {
    statusEl.textContent = 'Audio failed to load — check the URL / CORS';
  });
  document.body.appendChild(audioEl);
  audioEl.load();
  tryPlay();  // in case the camera already started before this config loaded
}

// Tear down the current track (on config reload). wantPlay PERSISTS — a user
// gesture doesn't expire just because the config's track changed, so a freshly
// loaded track can start without a second tap.
export function disposeAudio() {
  if (audioEl) {
    try { audioEl.pause(); audioEl.remove(); } catch (e) {}
  }
  audioEl = null;
  sourceURL = null;
}

// Is a global track loaded? When true it owns the clock (render.js reads
// getAudioTime instead of the per-piece captionElapsed) and the loop authority.
export function audioActive() {
  return !!audioEl;
}

// Current song position in seconds — the master clock value. 0 with no track.
export function getAudioTime() {
  return audioEl ? audioEl.currentTime : 0;
}

// The URL the current track came from, for serializing back into a config.
export function audioURL() {
  return sourceURL;
}