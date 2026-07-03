// ── youtube: DOM-iframe media overlay ─────────────────────────────────────────
// The fifth per-piece media type, and the one that can't go through render.js.
// A YouTube player is a cross-origin <iframe> — its frames aren't readable, so
// it can't be drawImage'd onto the canvas and clipped like image/video/gif.
// Instead each YouTube piece gets a real <iframe> floating over the canvas,
// repositioned every frame to the piece's smoothed hull bbox and clipped to the
// polygon with CSS clip-path. zoom/rotate/xshift/yshift are reproduced as a CSS
// transform so framing behaves the same as the canvas media types.
//
// Config-driven (persisted by configIO.js): url, volume, start, end, speed.
//   volume 0-100 · start/end in seconds (loops the [start,end] segment; end
//   null = loop the whole video) · speed = playbackRate (YouTube snaps it to
//   its nearest allowed rate). Autoplay always starts muted (browser policy);
//   the first tap anywhere unmutes to `volume` — same ergonomics as the
//   "tap the video area once to start" path the local <video> type already uses.
//
// Playback is TRANSITION-driven, not read-driven: play/pause/seek fire off our
// own tracked/untracked edge (state.smoothHulls[i] going non-null <-> null),
// never off a getPlayerState() read. That read goes over the same postMessage
// bridge that's known-flaky cross-origin (see the console warning YouTube
// itself logs); gating start-seek or end-clamp behind it silently swallows
// both if the bridge lags or sticks. Our own `_playing` flag is authoritative
// instead — see setPlaying().

import { N, PIECES } from './config.js';
import { state } from './state.js';
import { mainCanvas, statusEl } from './dom.js';
import { pieceMedia, disposeMedia } from './media.js';

const canvasWrap = document.getElementById('canvasWrap');

// ── IFrame API bootstrap ──────────────────────────────────────────────────────
// The API loads once, globally, and calls window.onYouTubeIframeAPIReady when
// YT.Player is available. whenYT() queues player creation until then.
let ytResolvers = [];
window.onYouTubeIframeAPIReady = () => {
  const q = ytResolvers; ytResolvers = [];
  for (const fn of q) { try { fn(); } catch (e) {} }
};
function whenYT(fn) {
  if (window.YT && window.YT.Player) { fn(); return; }
  ytResolvers.push(fn);
  if (!document.getElementById('yt-iframe-api')) {
    const s = document.createElement('script');
    s.id = 'yt-iframe-api';
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  }
}

// ── URL parsing ───────────────────────────────────────────────────────────────
// watch?v= / youtu.be / embed / shorts / live / bare 11-char id. Pulls a
// start time from ?t= or ?start= (seconds, or 1h2m3s form) as a convenience —
// an explicit config `start` still overrides it (see attachYouTube).
function parseTime(t) {
  if (/^\d+$/.test(t)) return +t;
  const m = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(t) || [];
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}
export function parseYouTube(url) {
  if (!url) return null;
  let videoId = null, start = 0;
  try {
    const u = new URL(url, location.href);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      videoId = u.pathname.slice(1).split('/')[0];
    } else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (u.pathname === '/watch') videoId = u.searchParams.get('v');
      else if (/^\/(embed|shorts|live)\//.test(u.pathname)) videoId = u.pathname.split('/')[2];
    }
    const t = u.searchParams.get('t') || u.searchParams.get('start');
    if (t) start = parseTime(t);
  } catch (e) { /* not a URL — maybe a bare id, handled below */ }
  if (!videoId && /^[\w-]{11}$/.test(url)) videoId = url;
  return videoId ? { videoId, start } : null;
}

// ── overlay layer (one per document, holds every YT piece's wrapper) ──────────
// Absolutely positioned inside canvasWrap so it tracks the canvas in both
// normal and immersive (fixed inset:0) layouts. z-index sits above the canvas
// but below the overlay panel / exit / toggle buttons, so controls stay usable.
let layerEl = null;
function ensureLayer() {
  if (layerEl) return layerEl;
  layerEl = document.createElement('div');
  layerEl.id = 'ytLayer';
  layerEl.style.cssText =
    'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:500;';
  canvasWrap.appendChild(layerEl);
  return layerEl;
}

// ── first-gesture audio unlock ────────────────────────────────────────────────
// Muted autoplay is guaranteed; sound needs a user gesture. Arm once the first
// YT piece exists; any tap then unmutes every YT piece to its configured volume.
// This does NOT force playback — play/pause is owned entirely by tracking (see
// setPlaying), so a tap while a piece is off-camera won't start a hidden video.
let audioArmed = false;
function armAudio() {
  if (audioArmed) return;
  audioArmed = true;
  const h = () => resumeYouTube();
  document.addEventListener('pointerdown', h);
  document.addEventListener('touchend', h);
}
export function resumeYouTube() {
  for (const m of pieceMedia) {
    if (!m || m.type !== 'youtube' || !m.player) continue;
    try { if (m.volume > 0) { m.player.unMute(); m.player.setVolume(m.volume); } } catch (e) {}
  }
}

// ── player creation ───────────────────────────────────────────────────────────
function createYouTube(i, cfg) {
  const videoId = cfg.videoId;
  const volume = cfg.volume == null ? 100 : +cfg.volume;
  const start  = cfg.start  == null ? 0    : +cfg.start;
  const end    = cfg.end    == null ? null : +cfg.end;
  const speed  = cfg.speed  == null ? 1    : +cfg.speed;

  const layer = ensureLayer();
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;overflow:hidden;display:none;pointer-events:auto;background:#000;';
  const stage = document.createElement('div');
  stage.style.cssText = 'position:absolute;transform-origin:center center;';
  const host = document.createElement('div');
  host.style.cssText = 'width:100%;height:100%;';
  const hostId = 'ytHost' + i + '_' + Math.random().toString(36).slice(2, 7);
  host.id = hostId;
  stage.appendChild(host);
  wrap.appendChild(stage);
  layer.appendChild(wrap);

  const rec = {
    type: 'youtube', el: null, url: null, name: 'YouTube ' + videoId,
    sourceURL: null, link: null,
    videoId, srcURL: cfg.url || ('https://youtu.be/' + videoId),
    volume, start, end, speed,
    wrap, stage, player: null,
    // Desired play state, driven purely by tracking transitions (see
    // setPlaying). Set even before the underlying YT.Player finishes
    // loading, so onReady below can honor whatever was requested in the
    // meantime instead of always starting paused-at-start.
    _playing: false,
    stop() {
      try { this.player && this.player.destroy && this.player.destroy(); } catch (e) {}
      try { this.wrap.remove(); } catch (e) {}
    },
  };

  whenYT(() => {
    rec.player = new YT.Player(hostId, {
      videoId,
      width: '100%', height: '100%',
      playerVars: {
        controls: 1, playsinline: 1, rel: 0, modestbranding: 1, fs: 0,
        disablekb: 1, origin: location.origin, mute: 1,
        // no autoplay/start/end here — driven explicitly via the JS API
        // below instead. playerVars' `end` in particular is unreliable
        // across browsers; explicit seekTo()/pauseVideo() calls are the
        // trustworthy path.
      },
      events: {
        onReady: e => {
          const p = e.target;
          try {
            p.setPlaybackRate(speed);
            p.setVolume(volume);
            if (rec._playing) {
              // already tracked by the time the player finished loading —
              // start right where the frame loop wanted it to.
              p.seekTo(rec.start || 0, true);
              p.playVideo();
            } else {
              // not tracked yet — cue (load, stay paused) at start so the
              // first real play doesn't stall on a cold load.
              p.cueVideoById({ videoId, startSeconds: rec.start || 0 });
            }
          } catch (_) {}
        },
        onStateChange: e => {
          // ENDED → loop back to `start` (whole-video loop case, i.e. no
          // `end` set — or a backstop if a frame was missed right as a
          // segment's natural end coincided with the video's real end).
          // Pushed by the SDK, not polled, so this fires reliably even if
          // getCurrentTime() reads are lagging.
          if (e.data === YT.PlayerState.ENDED) {
            try { e.target.seekTo(rec.start || 0, true); e.target.playVideo(); } catch (_) {}
          }
        },
      },
    });
  });

  return rec;
}

// Attach a YouTube video to piece i. `opts` (volume/start/end/speed) come from
// the config on load, or default on a fresh UI attach. Returns the record (set
// on pieceMedia[i] synchronously — the player itself finishes constructing
// asynchronously via whenYT), so callers like applyCalData can set .link right
// after. Mirrors media.js's attach* functions.
export function attachYouTube(i, url, opts = {}, refresh) {
  const parsed = parseYouTube(url);
  if (!parsed) {
    statusEl.textContent = `${PIECES[i].name}: not a recognizable YouTube URL`;
    return null;
  }
  disposeMedia(i);
  const cfg = {
    videoId: parsed.videoId,
    url,
    // explicit config start wins over a ?t= in the URL, which wins over 0
    start: opts.start != null ? opts.start : parsed.start,
    volume: opts.volume, end: opts.end, speed: opts.speed,
  };
  const rec = createYouTube(i, cfg);
  pieceMedia[i] = rec;
  statusEl.textContent = `${PIECES[i].name}: YouTube attached`;
  armAudio();
  if (refresh) refresh();
  return rec;
}

// ── per-frame overlay sync (called from main.js's frame loop) ─────────────────
// Visibility invariant: a YT overlay is shown iff state.smoothHulls[i] is
// non-null — exactly when render.js would be drawing (or holding, during a
// grace-period dropout) that piece. When a piece is really lost main.js nulls
// smoothHulls, and the overlay hides. Mapping handles object-fit:cover so it's
// correct in immersive mode too (in normal mode the box aspect matches the
// content, so cover == a plain uniform scale).
export function syncYouTubeOverlays(MW, MH) {
  if (!layerEl) return;
  const cr = mainCanvas.getBoundingClientRect();
  const wr = canvasWrap.getBoundingClientRect();
  const scale = Math.max(cr.width / MW, cr.height / MH);
  const dispW = MW * scale, dispH = MH * scale;
  const baseX = (cr.left - wr.left) + (cr.width  - dispW) / 2;
  const baseY = (cr.top  - wr.top)  + (cr.height - dispH) / 2;
  const calibrating = state.calibrating >= 0;

  for (let i = 0; i < N; i++) {
    const m = pieceMedia[i];
    if (!m || m.type !== 'youtube' || !m.wrap) continue;
    const hull = state.smoothHulls[i];
    if (!hull || hull.length < 3) { setPlaying(m, false); continue; }
    positionYT(i, m, hull, scale, baseX, baseY, calibrating);
    setPlaying(m, true);
  }
}

// Transition-driven, not state-read-driven: fires seek+play / pause exactly
// once per actual on/off edge, comparing against our OWN last-known
// `_playing` flag rather than asking the player to confirm its state first
// (getPlayerState() goes over the same postMessage bridge that can lag or
// stick cross-origin, and gating on it was silently swallowing both the
// start-seek and the end-clamp). If the player hasn't finished loading yet
// when a transition fires, onReady (above) picks up `_playing` and starts it
// correctly once ready.
function setPlaying(m, on) {
  m.wrap.style.display = on ? 'block' : 'none';

  if (on !== m._playing) {
    m._playing = on;
    const p = m.player;
    if (p) {
      try {
        if (on) { p.seekTo(m.start || 0, true); p.playVideo(); }
        else p.pauseVideo();
      } catch (e) {}
    }
    return;
  }

  // steady-state while playing: enforce the end clamp every frame. This read
  // (getCurrentTime) does use the bridge, but unlike the old gate it's no
  // longer load-bearing for start/play/pause — worst case here is a segment
  // playing a little past `end` if the bridge is lagging, not silently never
  // looping at all.
  if (on && m.end != null && m.player && m.player.getCurrentTime) {
    let t = 0; try { t = m.player.getCurrentTime(); } catch (e) { return; }
    if (t >= m.end) { try { m.player.seekTo(m.start || 0, true); } catch (e) {} }
  }
}

function positionYT(i, m, hull, scale, baseX, baseY, calibrating) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of hull) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  const W = (maxX - minX) * scale, H = (maxY - minY) * scale;
  const wrap = m.wrap;
  wrap.style.left   = (baseX + minX * scale) + 'px';
  wrap.style.top    = (baseY + minY * scale) + 'px';
  wrap.style.width  = W + 'px';
  wrap.style.height = H + 'px';
  // Let calibration/link taps reach the canvas while calibrating (the iframe
  // otherwise covers the piece you're trying to re-tap).
  wrap.style.pointerEvents = calibrating ? 'none' : 'auto';

  // clip to the piece polygon, in wrap-local px
  let pts = '';
  for (const p of hull) {
    pts += ((p[0] - minX) * scale).toFixed(1) + 'px ' + ((p[1] - minY) * scale).toFixed(1) + 'px,';
  }
  wrap.style.clipPath = 'polygon(' + pts.slice(0, -1) + ')';

  // stage = 16:9 cover-fit within W×H, then the piece's framing transform
  const aspect = 16 / 9;
  let sw, sh;
  if (W / H >= aspect) { sw = W; sh = W / aspect; } else { sh = H; sw = H * aspect; }
  const adj = state.mediaAdjust[i];
  m.stage.style.left   = ((W - sw) / 2) + 'px';
  m.stage.style.top    = ((H - sh) / 2) + 'px';
  m.stage.style.width  = sw + 'px';
  m.stage.style.height = sh + 'px';
  m.stage.style.transform =
    `translate(${adj.xshift * W}px, ${adj.yshift * H}px) scale(${adj.zoom}) rotate(${adj.rotate}deg)`;
}