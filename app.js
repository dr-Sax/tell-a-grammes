// ── config ────────────────────────────────────────────────────────────────────

const PIECES = [
  { name: 'Piece 1', color: '#e05555' },
  { name: 'Piece 2', color: '#e09055' },
  { name: 'Piece 3', color: '#d4c820' },
  { name: 'Piece 4', color: '#44b844' },
  { name: 'Piece 5', color: '#2299cc' },
  { name: 'Piece 6', color: '#7755dd' },
  { name: 'Piece 7', color: '#cc44aa' },
];
const N = PIECES.length;

// Smoothing: lerp factor for hull vertices each frame
const LERP = 0.3;
// Hull resampled to this many vertices for stable lerping
const HULL_VERTS = 20;
// Processing scale (lower = faster, less precise)
const PROC_SCALE = 0.4;
// Morphology radii (structuring element = (2r+1) square, separable)
const OPEN_R  = 1;   // erode→dilate: removes speckle
const CLOSE_R = 1;   // dilate→erode: bridges small gaps from glare

// ── state ─────────────────────────────────────────────────────────────────────

const state = {
  running: false,
  calibrating: -1,
  // per piece: { h (0-360), s (0-1), v (0-1) } mean from calibration tap
  calibrated: Array(N).fill(null),
  // smoothed hull polygon per piece [[x,y]…] in main canvas px
  smoothHulls: Array(N).fill(null),
  lastCounts: null,
};

let htol    = 9;    // hue tolerance, in OpenCV-style 0-180 units (×2 = degrees)
let stol    = 48;   // saturation tolerance on 0-255 scale (÷255 = fraction)
let vtol    = 35;   // value tolerance on 0-255 scale (÷255 = fraction)
let minArea = 250;  // minimum blob area in proc-scale pixels

let rotation = 0;   // display/capture rotation: 0 | 90 | 180 | 270
let mirror   = false; // horizontal flip
let showFeed = true;  // draw the camera feed, or a white lightbox, behind overlays

// ── per-frame work buffers (allocated once camera starts) ───────────────────────

let Hc, Sc, Vc;            // per-pixel HSV  (Float32: H 0-360, S/V 0-1)
let maskA, maskB, maskC;   // binary scratch masks (Uint8)
let labels, labelStack;    // connected-components labels + flood-fill stack
let committedBuf;          // pixels already claimed this frame (Uint8)
let silMinX, silMaxX;      // per-row silhouette extents for the winning blob

function allocBuffers(w, h) {
  const n = w * h;
  Hc = new Float32Array(n); Sc = new Float32Array(n); Vc = new Float32Array(n);
  maskA = new Uint8Array(n); maskB = new Uint8Array(n); maskC = new Uint8Array(n);
  labels = new Int32Array(n); labelStack = new Int32Array(n);
  committedBuf = new Uint8Array(n);
  silMinX = new Int32Array(h); silMaxX = new Int32Array(h);
}

// Draw the video into ctx (sized dw×dh) applying the current rotation + mirror.
// The SAME transform is used for the proc/read canvas, the display canvas, and
// the calibration sampler, so tracking, overlays, and taps share one frame.
function drawOriented(ctx, dw, dh) {
  const swap = (rotation === 90 || rotation === 270);
  const bw = swap ? dh : dw;   // un-rotated footprint to draw the source into
  const bh = swap ? dw : dh;
  ctx.save();
  ctx.translate(dw / 2, dh / 2);
  ctx.rotate(rotation * Math.PI / 180);
  if (mirror) ctx.scale(-1, 1);
  ctx.drawImage(video, -bw / 2, -bh / 2, bw, bh);
  ctx.restore();
}

// (Re)size main + proc canvases and buffers for the current rotation.
function applyOrientation() {
  const VW = video.videoWidth  || 640;
  const VH = video.videoHeight || 480;
  const swap = (rotation === 90 || rotation === 270);
  const MW = swap ? VH : VW;
  const MH = swap ? VW : VH;
  mainCanvas.width  = MW;
  mainCanvas.height = MH;
  const PW = Math.max(1, Math.round(MW * PROC_SCALE));
  const PH = Math.max(1, Math.round(MH * PROC_SCALE));
  readCanvas.width  = PW;
  readCanvas.height = PH;
  allocBuffers(PW, PH);
  state.smoothHulls = Array(N).fill(null); // coordinate space changed
  return { PW, PH };
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const mainCanvas  = document.getElementById('mainCanvas');
const mainCtx     = mainCanvas.getContext('2d', { willReadFrequently: false });
const tapHint     = document.getElementById('tapHint');
const crosshair   = document.getElementById('crosshair');
const statusEl    = document.getElementById('status');
const cvStatusEl  = document.getElementById('cvStatus');
const startBtn    = document.getElementById('startBtn');
const controlsEl  = document.getElementById('controls');
const uiEl        = document.getElementById('ui');
const debugBar    = document.getElementById('debugBar');

// hidden canvas for reading camera pixels at proc res
const readCanvas  = document.createElement('canvas');
const readCtx     = readCanvas.getContext('2d', { willReadFrequently: true });

const video = document.createElement('video');
video.autoplay = true; video.playsInline = true; video.muted = true;

// ── controls ──────────────────────────────────────────────────────────────────

document.getElementById('htolRange').oninput = e => {
  htol = +e.target.value;
  document.getElementById('htolVal').textContent = htol;
};
document.getElementById('stolRange').oninput = e => {
  stol = +e.target.value;
  document.getElementById('stolVal').textContent = stol;
};
document.getElementById('vtolRange').oninput = e => {
  vtol = +e.target.value;
  document.getElementById('vtolVal').textContent = vtol;
};
document.getElementById('minAreaRange').oninput = e => {
  minArea = +e.target.value;
  document.getElementById('minAreaVal').textContent = minArea;
};

// ── colour helpers ────────────────────────────────────────────────────────────

// Standard RGB→HSV, returns h 0-360, s 0-1, v 0-1
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
  let h = 0;
  if (d > 0) {
    if      (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, max > 0 ? d / max : 0, max];
}

function hsvToHex(h, s, v) {
  const f = n => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  const r = f(5), g = f(3), b = f(1);
  return '#' + [r,g,b].map(x => x.toString(16).padStart(2,'0')).join('');
}

// circular hue distance in degrees (0-180)
function hueDiff360(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ── calibration tap ───────────────────────────────────────────────────────────

mainCanvas.addEventListener('mousemove', e => {
  if (state.calibrating < 0) return;
  const rect = mainCanvas.getBoundingClientRect();
  crosshair.style.left = (e.clientX - rect.left) + 'px';
  crosshair.style.top  = (e.clientY - rect.top)  + 'px';
});

function calibrateAt(clientX, clientY) {
  if (state.calibrating < 0 || !state.running) return;
  const rect  = mainCanvas.getBoundingClientRect();
  const scaleX = readCanvas.width  / rect.width;
  const scaleY = readCanvas.height / rect.height;
  const px = Math.round((clientX - rect.left) * scaleX);
  const py = Math.round((clientY - rect.top)  * scaleY);

  // sample a patch around the tap from the proc-res read canvas
  drawOriented(readCtx, readCanvas.width, readCanvas.height);
  const r  = 6;
  const x0 = Math.max(0, px - r), y0 = Math.max(0, py - r);
  const w  = Math.min(readCanvas.width  - x0, r * 2);
  const h  = Math.min(readCanvas.height - y0, r * 2);
  if (w <= 0 || h <= 0) { statusEl.textContent = 'Tap inside the frame'; return; }
  const data = readCtx.getImageData(x0, y0, w, h).data;

  let hs = 0, ss = 0, vs = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [hh, s, v] = rgb2hsv(data[i], data[i+1], data[i+2]);
    if (s > 0.2 && v > 0.15) { hs += hh; ss += s; vs += v; n++; }
  }
  if (n < 4) { statusEl.textContent = 'Tap missed — too dark or unsaturated, try again'; return; }

  const cal = { h: hs/n, s: ss/n, v: vs/n };
  state.calibrated[state.calibrating] = cal;
  state.smoothHulls[state.calibrating] = null;

  statusEl.textContent =
    `${PIECES[state.calibrating].name} → H=${Math.round(cal.h)}° S=${cal.s.toFixed(2)} V=${cal.v.toFixed(2)}`;
  state.calibrating = -1;
  tapHint.style.display = 'none';
  crosshair.style.display = 'none';
  buildUI();
}

mainCanvas.addEventListener('click', e => calibrateAt(e.clientX, e.clientY));
// touch: tap to calibrate without firing a synthetic mouse scroll
mainCanvas.addEventListener('touchend', e => {
  if (state.calibrating < 0) return;
  e.preventDefault();
  const t = e.changedTouches[0];
  if (t) calibrateAt(t.clientX, t.clientY);
}, { passive: false });

// resume any autoplay-blocked piece videos on a canvas tap (iOS safety net)
mainCanvas.addEventListener('pointerdown', () => {
  if (state.calibrating >= 0) return;
  for (const m of pieceMedia) if (m && m.type === 'video' && m.el.paused) m.el.play().catch(()=>{});
});

// ── hull smoothing ────────────────────────────────────────────────────────────

function resamplePoly(pts, n) {
  if (pts.length === 0) return [];
  if (pts.length === n) return pts;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t  = (i / n) * pts.length;
    const lo = Math.floor(t) % pts.length;
    const hi = (lo + 1) % pts.length;
    const f  = t - Math.floor(t);
    out.push([
      pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f,
      pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f,
    ]);
  }
  return out;
}

function lerpPoly(prev, next) {
  if (!prev || prev.length !== next.length) return next;
  return prev.map((p, i) => [
    p[0] + (next[i][0] - p[0]) * LERP,
    p[1] + (next[i][1] - p[1]) * LERP,
  ]);
}

// Andrew's monotone-chain convex hull. pts: [[x,y]…] → hull [[x,y]…] CCW
function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 &&
           cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 &&
           cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// ── per-pixel HSV for the whole frame ───────────────────────────────────────────

function computeHSV(img, count) {
  for (let p = 0, q = 0; p < count; p++, q += 4) {
    const r = img[q] / 255, g = img[q+1] / 255, b = img[q+2] / 255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
    let h = 0;
    if (d > 0) {
      if      (max === r) h = ((g - b) / d + 6) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else                h = (r - g) / d + 4;
      h *= 60;
    }
    Hc[p] = h;
    Sc[p] = max > 0 ? d / max : 0;
    Vc[p] = max;
  }
}

// build a binary mask of pixels matching `cal`, excluding already-committed pixels
function buildMask(cal, mask, count) {
  const ch = cal.h, cs = cal.s, cvv = cal.v;
  const hT = htol * 2;     // degrees
  const sT = stol / 255;   // fraction
  const vT = vtol / 255;   // fraction
  for (let p = 0; p < count; p++) {
    if (committedBuf[p]) { mask[p] = 0; continue; }
    let dh = Math.abs(Hc[p] - ch) % 360; if (dh > 180) dh = 360 - dh;
    mask[p] = (dh <= hT &&
               Math.abs(Sc[p] - cs) <= sT &&
               Math.abs(Vc[p] - cvv) <= vT) ? 1 : 0;
  }
}

// ── morphology (separable binary erode/dilate, square SE) ────────────────────────

// horiz pass into tmp, vert pass into dst. erode = AND over window, dilate = OR.
function morphPass(src, dst, tmp, w, h, r, erode) {
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      let acc = erode ? 1 : 0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        const v = (xx < 0 || xx >= w) ? 0 : src[off + xx];
        if (erode) { if (!v) { acc = 0; break; } }
        else       { if (v)  { acc = 1; break; } }
      }
      tmp[off + x] = acc;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = erode ? 1 : 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        const v = (yy < 0 || yy >= h) ? 0 : tmp[yy * w + x];
        if (erode) { if (!v) { acc = 0; break; } }
        else       { if (v)  { acc = 1; break; } }
      }
      dst[y * w + x] = acc;
    }
  }
}

// open/close operate on maskA, using maskB & maskC as scratch, result back in maskA
function morphOpen(w, h, r) {
  if (r <= 0) return;
  morphPass(maskA, maskB, maskC, w, h, r, true);   // erode → maskB
  morphPass(maskB, maskA, maskC, w, h, r, false);  // dilate → maskA
}
function morphClose(w, h, r) {
  if (r <= 0) return;
  morphPass(maskA, maskB, maskC, w, h, r, false);  // dilate → maskB
  morphPass(maskB, maskA, maskC, w, h, r, true);   // erode → maskA
}

// ── connected components: label everything, return largest blob's label/area ─────

function largestBlob(mask, w, h, minA) {
  const n = w * h;
  labels.fill(0);
  let cur = 0, bestLabel = 0, bestArea = minA; // strictly greater than minArea
  for (let s = 0; s < n; s++) {
    if (!mask[s] || labels[s]) continue;
    cur++;
    let sp = 0;
    labelStack[sp++] = s;
    labels[s] = cur;
    let area = 0;
    while (sp > 0) {
      const idx = labelStack[--sp];
      area++;
      const x = idx % w, y = (idx / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= h) continue;
        const nrow = ny * w;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx; if (nx < 0 || nx >= w) continue;
          const nidx = nrow + nx;
          if (mask[nidx] && !labels[nidx]) { labels[nidx] = cur; labelStack[sp++] = nidx; }
        }
      }
    }
    if (area > bestArea) { bestArea = area; bestLabel = cur; }
  }
  return bestLabel ? { label: bestLabel, area: bestArea } : null;
}

// for the winning label: mark committed pixels and collect per-row silhouette points
function silhouetteAndCommit(label, w, h) {
  for (let y = 0; y < h; y++) { silMinX[y] = 1e9; silMaxX[y] = -1; }
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      const idx = off + x;
      if (labels[idx] === label) {
        committedBuf[idx] = 1;
        if (x < silMinX[y]) silMinX[y] = x;
        if (x > silMaxX[y]) silMaxX[y] = x;
      }
    }
  }
  const pts = [];
  for (let y = 0; y < h; y++) {
    if (silMaxX[y] >= 0) {
      pts.push([silMinX[y], y]);
      if (silMaxX[y] !== silMinX[y]) pts.push([silMaxX[y], y]);
    }
  }
  return pts;
}

// ── main loop ────────────────────────────────────────────────────────────────

function processFrame() {
  if (!state.running) return;

  const PW = readCanvas.width, PH = readCanvas.height;
  const MW = mainCanvas.width, MH = mainCanvas.height;
  const scaleX = MW / PW, scaleY = MH / PH;
  const count = PW * PH;

  drawOriented(readCtx, PW, PH);
  const img = readCtx.getImageData(0, 0, PW, PH).data;

  computeHSV(img, count);

  // background: live camera feed, or a white lightbox to illuminate the pieces.
  // (Tracking always reads the proc buffer above, so detection is unaffected.)
  if (showFeed) {
    drawOriented(mainCtx, MW, MH);
  } else {
    mainCtx.fillStyle = '#fff';
    mainCtx.fillRect(0, 0, MW, MH);
  }

  const counts = Array(N).fill(0);
  committedBuf.fill(0);

  // larger / more certain pieces (by last frame area) claim pixels first
  const order = Array.from({length: N}, (_, i) => i)
    .filter(i => state.calibrated[i])
    .sort((a, b) => (state.lastCounts?.[b] || 0) - (state.lastCounts?.[a] || 0));

  for (const i of order) {
    buildMask(state.calibrated[i], maskA, count);
    morphOpen(PW, PH, OPEN_R);
    morphClose(PW, PH, CLOSE_R);

    const blob = largestBlob(maskA, PW, PH, minArea);
    counts[i] = blob ? Math.round(blob.area) : 0;

    if (!blob) { state.smoothHulls[i] = null; continue; }

    const sil = silhouetteAndCommit(blob.label, PW, PH);
    let hull = convexHull(sil);
    hull = hull.map(p => [p[0] * scaleX, p[1] * scaleY]);

    const resampled = resamplePoly(hull, HULL_VERTS);
    state.smoothHulls[i] = lerpPoly(state.smoothHulls[i], resampled);

    drawOverlay(state.smoothHulls[i], i, MW, MH);
  }

  state.lastCounts = counts;

  debugBar.innerHTML = Array.from({length:N}, (_,i) => i).map(i => {
    if (!state.calibrated[i]) return '';
    const c = counts[i];
    const col = hsvToHex(state.calibrated[i].h, state.calibrated[i].s, state.calibrated[i].v);
    return c > 0
      ? `<span class="dbadge" style="background:${col}22;color:${col};border:1px solid ${col}88">${PIECES[i].name} ${c}px</span>`
      : `<span class="dbadge" style="color:#444;border:1px solid #222">${PIECES[i].name} —</span>`;
  }).join('');

  requestAnimationFrame(processFrame);
}

// per piece: { type: 'image'|'video', el, url, name } or null
const pieceMedia = Array(N).fill(null);

function disposeMedia(i) {
  const m = pieceMedia[i];
  if (!m) return;
  if (m.url) URL.revokeObjectURL(m.url);
  if (m.type === 'video') { try { m.el.pause(); m.el.remove(); } catch(e){} }
  pieceMedia[i] = null;
}

function drawOverlay(hull, i, MW, MH) {
  if (!hull || hull.length < 3) return;
  const cal = state.calibrated[i];
  const color = hsvToHex(cal.h, cal.s, cal.v);

  mainCtx.save();
  mainCtx.beginPath();
  mainCtx.moveTo(hull[0][0], hull[0][1]);
  for (let j = 1; j < hull.length; j++) mainCtx.lineTo(hull[j][0], hull[j][1]);
  mainCtx.closePath();
  mainCtx.clip();

  const media = pieceMedia[i];
  if (media && (media.type === 'image' || (media.type === 'video' && !media.el.paused))) {
    const xs = hull.map(p => p[0]), ys = hull.map(p => p[1]);
    const bx = Math.min(...xs), by = Math.min(...ys);
    const bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;
    const mw = media.el.videoWidth  || media.el.naturalWidth  || 1;
    const mh = media.el.videoHeight || media.el.naturalHeight || 1;
    const scale = Math.max(bw / mw, bh / mh);
    const dw = mw * scale, dh = mh * scale;
    const dx = bx + (bw - dw) / 2, dy = by + (bh - dh) / 2;
    mainCtx.globalAlpha = 0.92;
    mainCtx.drawImage(media.el, dx, dy, dw, dh);
    mainCtx.globalAlpha = 1;
  } else {
    mainCtx.globalAlpha = 0.45;
    mainCtx.fillStyle = color;
    mainCtx.fillRect(0, 0, MW, MH);
    mainCtx.globalAlpha = 1;
  }

  mainCtx.restore();

  mainCtx.save();
  mainCtx.strokeStyle = color;
  mainCtx.lineWidth = 2;
  mainCtx.beginPath();
  mainCtx.moveTo(hull[0][0], hull[0][1]);
  for (let j = 1; j < hull.length; j++) mainCtx.lineTo(hull[j][0], hull[j][1]);
  mainCtx.closePath();
  mainCtx.stroke();
  mainCtx.restore();
}

// ── UI ────────────────────────────────────────────────────────────────────────

function conflictsWith(i) {
  const cal = state.calibrated[i];
  if (!cal) return null;
  for (let j = 0; j < N; j++) {
    if (j === i || !state.calibrated[j]) continue;
    if (hueDiff360(cal.h, state.calibrated[j].h) < htol * 2) return j;
  }
  return null;
}

function buildUI() {
  uiEl.innerHTML = '';
  PIECES.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'piece-row';

    const main = document.createElement('div');
    main.className = 'piece-main';

    const sw = document.createElement('div');
    sw.className = 'swatch';
    const cal = state.calibrated[i];
    sw.style.background = cal ? hsvToHex(cal.h, cal.s, cal.v) : p.color;
    sw.style.opacity = cal ? '1' : '0.35';

    const lbl = document.createElement('span');
    lbl.className = 'piece-label';
    const conflict = conflictsWith(i);
    lbl.textContent = p.name;
    if (conflict !== null) {
      const dist = Math.round(hueDiff360(cal.h, state.calibrated[conflict].h));
      lbl.textContent += ` ⚠ ~${dist}°`;
      lbl.style.color = '#c84';
    }

    const stats = document.createElement('span');
    stats.className = 'piece-stats';
    stats.textContent = cal ? `H${Math.round(cal.h)}° S${cal.s.toFixed(2)}` : '—';

    const calBtn = document.createElement('button');
    calBtn.className = 'cal-btn' +
      (state.calibrating === i ? ' active' : '') +
      (cal ? ' done' : '');
    calBtn.textContent = cal ? '✓ recal' : 'calibrate';
    calBtn.disabled = !state.running;
    calBtn.onclick = () => {
      state.calibrating = state.calibrating === i ? -1 : i;
      const on = state.calibrating >= 0;
      tapHint.style.display   = on ? 'block' : 'none';
      crosshair.style.display = on ? 'block' : 'none';
      tapHint.textContent = on ? `Tap the ${PIECES[state.calibrating].name} in the frame` : '';
      buildUI();
    };

    const clrBtn = document.createElement('button');
    clrBtn.className = 'clear-btn';
    clrBtn.textContent = '✕';
    clrBtn.title = 'Clear calibration';
    clrBtn.disabled = !cal;
    clrBtn.onclick = () => {
      state.calibrated[i] = null;
      state.smoothHulls[i] = null;
      buildUI();
    };

    main.append(sw, lbl, stats, calBtn, clrBtn);

    const mediaRow = document.createElement('div');
    mediaRow.className = 'piece-media';

    const thumb = document.createElement('img');
    thumb.className = 'media-thumb' + (pieceMedia[i] ? ' on' : '');
    thumb.id = `thumb${i}`;
    if (pieceMedia[i]) {
      if (pieceMedia[i].type === 'image') {
        thumb.src = pieceMedia[i].el.src;
      } else {
        const tc = document.createElement('canvas');
        tc.width = 40; tc.height = 28;
        try { tc.getContext('2d').drawImage(pieceMedia[i].el, 0, 0, 40, 28); } catch(e){}
        thumb.src = tc.toDataURL();
      }
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'media-name';
    nameEl.textContent = pieceMedia[i] ? pieceMedia[i].name : 'no media';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*,video/*';
    fileInput.style.display = 'none';
    fileInput.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;

      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const isVideo = file.type.startsWith('video/') ||
                      ['mov','mp4','m4v','webm','ogv','3gp','avi'].includes(ext);

      const setMedia = (type, el, url) => {
        disposeMedia(i);
        pieceMedia[i] = { type, el, url, name: file.name };
        statusEl.textContent = `${PIECES[i].name}: ${type} attached`;
        buildUI();
      };

      if (isVideo) {
        // blob: URL attached via a <source> child — the documented iOS-safe
        // path for video (src-attribute blob URLs are flaky on Safari).
        const url = URL.createObjectURL(file);
        const vid = document.createElement('video');
        vid.loop = true; vid.muted = true; vid.playsInline = true;
        vid.setAttribute('playsinline', '');
        vid.setAttribute('webkit-playsinline', '');
        const srcEl = document.createElement('source');
        srcEl.src = url; srcEl.type = file.type || 'video/mp4';
        vid.appendChild(srcEl);
        // iOS won't decode frames from a detached/hidden video — keep it in the
        // DOM, on-screen but effectively invisible.
        vid.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
        document.body.appendChild(vid);
        vid.load();
        const start = () => vid.play().then(() => setMedia('video', vid, url))
          .catch(() => { setMedia('video', vid, url);
            statusEl.textContent = `${PIECES[i].name}: tap the video area once to start playback`; });
        if (vid.readyState >= 2) start();
        else vid.addEventListener('loadeddata', start, { once: true });
        vid.onerror = () => {
          statusEl.textContent = 'Video failed — if testing in an in-app preview, open the file in Safari instead';
          URL.revokeObjectURL(url);
        };
      } else {
        // Images: read as a data URL instead of a blob URL. Data URLs are
        // origin-independent, so they load even in sandboxed iframes
        // (blob:null) and dodge Safari's blob-into-<img> quirks.
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
      e.target.value = '';
    };

    const upBtn = document.createElement('button');
    upBtn.className = 'upload-btn';
    upBtn.textContent = pieceMedia[i] ? '⟳ swap' : '+ media';
    upBtn.onclick = () => fileInput.click();

    const clrMediaBtn = document.createElement('button');
    clrMediaBtn.className = 'clear-media-btn';
    clrMediaBtn.textContent = '✕';
    clrMediaBtn.disabled = !pieceMedia[i];
    clrMediaBtn.onclick = () => {
      disposeMedia(i);
      buildUI();
    };

    mediaRow.append(thumb, nameEl, fileInput, upBtn, clrMediaBtn);
    row.append(main, mediaRow);
    uiEl.appendChild(row);
  });
}

// ── save / load calibration ───────────────────────────────────────────────────

function getCalData() {
  return {
    htol, stol, vtol, minArea, rotation, mirror,
    pieces: state.calibrated.map((c, i) => c ? { ...c, name: PIECES[i].name } : null),
  };
}

function applyCalData(data) {
  if (data.htol    !== undefined) { htol    = data.htol;    document.getElementById('htolRange').value  = htol;    document.getElementById('htolVal').textContent  = htol; }
  if (data.stol    !== undefined) { stol    = data.stol;    document.getElementById('stolRange').value  = stol;    document.getElementById('stolVal').textContent  = stol; }
  if (data.vtol    !== undefined) { vtol    = data.vtol;    document.getElementById('vtolRange').value  = vtol;    document.getElementById('vtolVal').textContent  = vtol; }
  if (data.minArea !== undefined) { minArea = data.minArea; document.getElementById('minAreaRange').value = minArea; document.getElementById('minAreaVal').textContent = minArea; }
  if (data.rotation !== undefined) rotation = ((data.rotation % 360) + 360) % 360;
  if (data.mirror   !== undefined) mirror   = !!data.mirror;
  refreshOrientUI();
  if (state.running) applyOrientation();
  if (Array.isArray(data.pieces)) {
    data.pieces.forEach((c, i) => {
      state.calibrated[i] = c ? { h: c.h, s: c.s, v: c.v } : null;
      state.smoothHulls[i] = null;
    });
  }
  buildUI();
}

document.getElementById('saveBtn').onclick = () => {
  const data = JSON.stringify(getCalData(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'tangram-calibration.json';
  a.click();
  URL.revokeObjectURL(url);
  document.getElementById('calName').textContent = 'saved ✓';
};

document.getElementById('loadBtn').onclick = () => {
  document.getElementById('loadFile').click();
};

document.getElementById('loadFile').onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      applyCalData(data);
      document.getElementById('calName').textContent = `loaded: ${file.name}`;
      statusEl.textContent = 'Calibration loaded — start camera to begin tracking';
    } catch(err) {
      statusEl.textContent = 'Failed to parse calibration file';
    }
  };
  reader.readAsText(file);
  e.target.value = '';
};

document.getElementById('clearAllBtn').onclick = () => {
  if (!confirm('Clear all calibrations?')) return;
  state.calibrated = Array(N).fill(null);
  state.smoothHulls = Array(N).fill(null);
  document.getElementById('calName').textContent = '';
  buildUI();
};

// ── camera start ──────────────────────────────────────────────────────────────

startBtn.onclick = async () => {
  try {
    statusEl.textContent = 'Requesting camera…';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: {ideal: 640}, height: {ideal: 480} },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    const { PW, PH } = applyOrientation();

    state.running = true;
    startBtn.style.display = 'none';
    controlsEl.style.display = 'flex';
    document.getElementById('calControls').style.display = 'flex';
    cvStatusEl.textContent = `Running at ${PW}×${PH} proc res — pure JS`;
    statusEl.textContent = 'Tap "calibrate" then tap a piece in the frame';
    buildUI();
    processFrame();
  } catch(e) {
    statusEl.textContent = 'Camera error: ' + e.message +
      (location.protocol !== 'https:' && location.hostname !== 'localhost'
        ? ' — iOS requires HTTPS for camera access.' : '');
  }
};

// ── fullscreen / immersive present mode ─────────────────────────────────────

const fsBtn  = document.getElementById('fsBtn');
const exitFs = document.getElementById('exitFs');

function enterImmersive() {
  document.body.classList.add('immersive');
  // Real Fullscreen API where it exists (desktop / Android / iPadOS).
  // iPhone Safari has no element fullscreen — the CSS class handles layout there.
  const wrap = document.getElementById('canvasWrap');
  const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
  if (req) { try { const p = req.call(wrap); if (p && p.catch) p.catch(()=>{}); } catch(e){} }
  setTimeout(() => window.scrollTo(0, 1), 80); // nudge Safari toolbars to collapse
}

function exitImmersive() {
  document.body.classList.remove('immersive');
  const ex = document.exitFullscreen || document.webkitExitFullscreen;
  if (ex && (document.fullscreenElement || document.webkitFullscreenElement)) {
    try { const p = ex.call(document); if (p && p.catch) p.catch(()=>{}); } catch(e){}
  }
}

fsBtn.onclick  = enterImmersive;
exitFs.onclick = exitImmersive;

// keep the class in sync if the user exits real fullscreen via Esc / system gesture
const onFsChange = () => {
  if (!document.fullscreenElement && !document.webkitFullscreenElement)
    document.body.classList.remove('immersive');
};
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);

// ── orientation: rotate / flip for the landscape-TV rig ─────────────────────

const rotBtn  = document.getElementById('rotBtn');
const flipBtn = document.getElementById('flipBtn');

function refreshOrientUI() {
  rotBtn.textContent = `⟳ ${rotation}°`;
  flipBtn.classList.toggle('active', mirror);
}

rotBtn.onclick = () => {
  rotation = (rotation + 90) % 360;
  if (state.running) applyOrientation();   // swaps canvas dims + resets hulls
  refreshOrientUI();
};

flipBtn.onclick = () => {
  mirror = !mirror;                         // no realloc needed — draw-time only
  state.smoothHulls = Array(N).fill(null);
  refreshOrientUI();
};

const feedBtn = document.getElementById('feedBtn');
function toggleFeed() {
  showFeed = !showFeed;
  feedBtn.textContent = showFeed ? '📷 feed on' : '⬜ feed off';
  feedBtn.classList.toggle('active', !showFeed);
  statusEl.textContent = `feed ${showFeed ? 'ON' : 'OFF'}`;   // ← confirms the tap landed
}
// pointerup fires for mouse, touch and pen in a single event — no desktop double-toggle.
feedBtn.addEventListener('pointerup', toggleFeed);

buildUI();