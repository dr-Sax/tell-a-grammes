// ── GIF support ───────────────────────────────────────────────────────────────
// Animated-GIF playback. A GIF drawn straight from an <img> into a canvas only
// ever yields ONE static frame, so we decode the GIF (gifuct-js) — but instead
// of retaining every frame's full-res RGBA patch forever (which is what OOM-
// killed the tab on mobile: ~5 bytes/px × frames × gifs), we composite the
// whole loop ONCE at decode time into a capped-size sequence of ImageBitmaps,
// then discard all gifuct data. Playback just replays the small bitmaps onto
// the offscreen canvas that render.js draws each rAF.
//
// Memory per gif drops from (W × H × 5B × frameCount) to
// (≤MAX_DIM² × 4B × frameCount) — e.g. a 480px, 100-frame gif goes from
// ~115 MB resident to ~23 MB, and far less if the source URL is already a
// downsized rendition.

import { parseGIF, decompressFrames } from 'https://esm.sh/gifuct-js@2.1.2';

// Largest dimension of the stored playback frames. Overlays are poured through
// a colour stencil and scaled by render.js anyway, so 240px is plenty; raise it
// if a config genuinely needs crisper full-screen gifs on desktop.
const MAX_DIM = 240;

// Detect if a file is a GIF by extension or MIME type.
export function isGif(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return ext === 'gif' || file.type === 'image/gif';
}

// Decode `file` and return { el, type:'gif', stop }. `el` is an offscreen canvas
// at the (capped) output size, animated in the background; `stop()` halts the
// timer AND closes the frame bitmaps so a pool reload actually frees memory.
export async function loadGif(file) {
  const buffer = await file.arrayBuffer();
  const gif = parseGIF(buffer);
  const frames = decompressFrames(gif, true);   // true → build RGBA .patch
  if (!frames.length) throw new Error('no frames decoded');

  const W = gif.lsd.width, H = gif.lsd.height;
  const scale = Math.min(1, MAX_DIM / Math.max(W, H));
  const outW = Math.max(1, Math.round(W * scale));
  const outH = Math.max(1, Math.round(H * scale));

  // Full-res compositor — TEMPORARY. Used only during this pre-render pass,
  // then everything full-res becomes garbage.
  const full = document.createElement('canvas');
  full.width = W; full.height = H;
  const fctx = full.getContext('2d');

  // Scratch canvas for putImageData'ing each frame's patch, as before.
  const patchCanvas = document.createElement('canvas');
  const patchCtx = patchCanvas.getContext('2d');
  let patchData = null;

  // Pre-render every frame once → small { bmp, delay } records.
  const rendered = [];
  let savedState = null;   // for disposal type 3 (restore-to-previous)
  for (const frame of frames) {
    // disposal 3 means "after showing this frame, restore what was underneath",
    // so snapshot the compositor before drawing over it.
    if (frame.disposalType === 3) {
      savedState = fctx.getImageData(0, 0, W, H);
    }

    const { width, height, left, top } = frame.dims;
    if (!patchData || patchData.width !== width || patchData.height !== height) {
      patchCanvas.width  = width;
      patchCanvas.height = height;
      patchData = patchCtx.createImageData(width, height);
    }
    patchData.data.set(frame.patch);
    patchCtx.putImageData(patchData, 0, 0);
    fctx.drawImage(patchCanvas, left, top);

    // Snapshot the composited frame at the capped size.
    const bmp = await createImageBitmap(full, {
      resizeWidth: outW, resizeHeight: outH, resizeQuality: 'medium',
    });
    // GIF delays of 0 (or absurdly small) are treated by browsers as ~100ms.
    const delay = frame.delay >= 20 ? frame.delay : 100;
    rendered.push({ bmp, delay });

    // Apply THIS frame's disposal to prep the compositor for the next frame.
    if (frame.disposalType === 2) {
      fctx.clearRect(left, top, width, height);
    } else if (frame.disposalType === 3 && savedState) {
      fctx.putImageData(savedState, 0, 0);
    }
    // disposal 0 / 1 → leave compositor as-is; next frame draws on top
  }
  frames.length = 0;   // release all decoded patch/pixel arrays to GC
  savedState = null;

  // Playback canvas at the SMALL size — this is what render.js draws each rAF.
  const canvas = document.createElement('canvas');
  canvas.width  = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');

  let idx = 0;
  let timer = null;
  let stopped = false;

  function step() {
    if (stopped) return;
    const f = rendered[idx];
    ctx.clearRect(0, 0, outW, outH);   // each bitmap is fully composited
    ctx.drawImage(f.bmp, 0, 0);
    timer = setTimeout(() => {
      idx = (idx + 1) % rendered.length;
      step();
    }, f.delay);
  }

  step();

  return {
    el: canvas,
    type: 'gif',
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      for (const f of rendered) if (f.bmp.close) f.bmp.close();
      rendered.length = 0;
    },
  };
}