// ── camera ──────────────────────────────────────────────────────────────────
// Owns the capture video and the proc-resolution read canvas.

import { PROC_TARGET_W, N } from './config.js';
import { state } from './state.js';
import { allocBuffers } from './tracker.js';
import { mainCanvas } from './dom.js';

export const video = document.createElement('video');
video.autoplay = true; video.playsInline = true; video.muted = true;
video.setAttribute('playsinline', '');
video.setAttribute('webkit-playsinline', '');

// iOS won't reliably decode frames from a <video> that isn't in the DOM — it
// plays briefly then suspends, which reads as a frozen feed (the draw loop
// keeps running, the video just stops producing new frames). Keep it in the
// document, tiny and effectively invisible, exactly like the piece videos.
video.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
document.body.appendChild(video);

// Belt-and-suspenders: if iOS suspends the live stream anyway, resume it.
video.addEventListener('pause', () => { if (video.srcObject) video.play().catch(() => {}); });

export const readCanvas = document.createElement('canvas');
export const readCtx = readCanvas.getContext('2d', { willReadFrequently: true });

// Draw the video into ctx (sized dw×dh).
export function drawOriented(ctx, dw, dh) {
  ctx.drawImage(video, 0, 0, dw, dh);
}

// (Re)size canvases + buffers. Returns proc dims.
export function applyOrientation() {
  const MW = video.videoWidth  || 640;
  const MH = video.videoHeight || 480;
  mainCanvas.width = MW;
  mainCanvas.height = MH;
  const procScale = Math.min(1, PROC_TARGET_W / MW);
  const PW = Math.max(1, Math.round(MW * procScale));
  const PH = Math.max(1, Math.round(MH * procScale));
  readCanvas.width = PW;
  readCanvas.height = PH;
  allocBuffers(PW, PH);
  state.smoothHulls = Array(N).fill(null);  // coordinate space changed
  state.smoothArea  = Array(N).fill(0);
  return { PW, PH };
}

// Acquire the rear camera and start playback. Returns proc dims on success;
// throws on failure (caller surfaces the error).
export async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return applyOrientation();
}