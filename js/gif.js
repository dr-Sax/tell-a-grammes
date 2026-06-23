// ── GIF support ───────────────────────────────────────────────────────────────
// Animated-GIF playback. A GIF drawn straight from an <img> into a canvas only
// ever yields ONE static frame — drawImage samples whatever frame the element
// happens to hold, and never advances. So we decode the GIF into its frames
// (gifuct-js) and composite them onto an offscreen canvas on a per-frame timer.
// That canvas is what render.js draws each rAF, so the overlay animates.

import { parseGIF, decompressFrames } from 'https://esm.sh/gifuct-js@2.1.2';

// Detect if a file is a GIF by extension or MIME type.
export function isGif(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return ext === 'gif' || file.type === 'image/gif';
}

// Decode `file` and return { el, type:'gif', stop }. `el` is an offscreen canvas
// at the GIF's logical-screen size, animated in the background; `stop()` halts
// the timer (called from disposeMedia). The canvas is a valid drawImage source
// and exposes .width/.height for render.js scaling.
export async function loadGif(file) {
  const buffer = await file.arrayBuffer();
  const gif = parseGIF(buffer);
  const frames = decompressFrames(gif, true);   // true → build RGBA .patch
  if (!frames.length) throw new Error('no frames decoded');

  // The composited output canvas (full logical screen size).
  const canvas = document.createElement('canvas');
  canvas.width  = gif.lsd.width;
  canvas.height = gif.lsd.height;
  const ctx = canvas.getContext('2d');

  // Scratch canvas: each frame's patch is putImageData'd here, then blitted to
  // the output at the frame's (left, top). A reused ImageData avoids realloc.
  const patchCanvas = document.createElement('canvas');
  const patchCtx = patchCanvas.getContext('2d');
  let patchData = null;

  function drawPatch(frame) {
    const { width, height, left, top } = frame.dims;
    if (!patchData || patchData.width !== width || patchData.height !== height) {
      patchCanvas.width  = width;
      patchCanvas.height = height;
      patchData = patchCtx.createImageData(width, height);
    }
    patchData.data.set(frame.patch);
    patchCtx.putImageData(patchData, 0, 0);
    ctx.drawImage(patchCanvas, left, top);
  }

  let idx = 0;
  let timer = null;
  let stopped = false;
  let savedState = null;   // for disposal type 3 (restore-to-previous)

  function step() {
    if (stopped) return;
    const frame = frames[idx];

    // disposal 3 means "after showing this frame, restore what was underneath",
    // so snapshot the canvas before we draw over it.
    if (frame.disposalType === 3) {
      savedState = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    drawPatch(frame);

    // GIF delays of 0 (or absurdly small) are treated by browsers as ~100ms.
    const delay = frame.delay >= 20 ? frame.delay : 100;

    timer = setTimeout(() => {
      // apply THIS frame's disposal to prep the canvas for the next frame
      if (frame.disposalType === 2) {
        // restore to background → clear just this frame's rectangle
        const { width, height, left, top } = frame.dims;
        ctx.clearRect(left, top, width, height);
      } else if (frame.disposalType === 3 && savedState) {
        ctx.putImageData(savedState, 0, 0);
      }
      // disposal 0 / 1 → leave canvas as-is; next frame draws on top
      idx = (idx + 1) % frames.length;
      step();
    }, delay);
  }

  step();

  return {
    el: canvas,
    type: 'gif',
    stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } },
  };
}