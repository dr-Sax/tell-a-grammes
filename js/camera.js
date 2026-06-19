// ── camera + orientation ──────────────────────────────────────────────────────
// Owns the capture video and the proc-resolution read canvas, plus the shared
// draw transform (rotation + mirror) used for tracking, display, and taps.

import { PROC_TARGET_W, N } from './config.js';
import { state } from './state.js';
import { allocBuffers } from './tracker.js';
import { mainCanvas } from './dom.js';

export const video = document.createElement('video');
video.autoplay = true; video.playsInline = true; video.muted = true;

export const readCanvas = document.createElement('canvas');
export const readCtx = readCanvas.getContext('2d', { willReadFrequently: true });

// Draw the video into ctx (sized dw×dh) applying the current rotation + mirror.
export function drawOriented(ctx, dw, dh) {
  const swap = (state.rotation === 90 || state.rotation === 270);
  const bw = swap ? dh : dw;   // un-rotated footprint to draw the source into
  const bh = swap ? dw : dh;
  ctx.save();
  ctx.translate(dw / 2, dh / 2);
  ctx.rotate(state.rotation * Math.PI / 180);
  if (state.mirror) ctx.scale(-1, 1);
  ctx.drawImage(video, -bw / 2, -bh / 2, bw, bh);
  ctx.restore();
}

// (Re)size canvases + buffers for the current rotation. Returns proc dims.
export function applyOrientation() {
  const VW = video.videoWidth  || 640;
  const VH = video.videoHeight || 480;
  const swap = (state.rotation === 90 || state.rotation === 270);
  const MW = swap ? VH : VW;
  const MH = swap ? VW : VH;
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