// ── DOM references ────────────────────────────────────────────────────────────
// One place to resolve the elements declared in index.html. Module scripts are
// deferred, so the DOM is fully parsed by the time this evaluates.

export const mainCanvas  = document.getElementById('mainCanvas');
export const mainCtx     = mainCanvas.getContext('2d', { willReadFrequently: false });
export const stereoCanvas = document.getElementById('stereoCanvas');
export const stereoCtx    = stereoCanvas.getContext('2d');
export const canvasWrap = document.getElementById('canvasWrap');
export const tapHint     = document.getElementById('tapHint');
export const crosshair   = document.getElementById('crosshair');
export const statusEl    = document.getElementById('status');
export const cvStatusEl  = document.getElementById('cvStatus');
export const startBtn    = document.getElementById('startBtn');
export const controlsEl  = document.getElementById('controls');
export const calControls = document.getElementById('calControls');
export const uiEl        = document.getElementById('ui');
export const debugBar    = document.getElementById('debugBar');
export const overlayPanel  = document.getElementById('overlayPanel');
export const panelToggle   = document.getElementById('panelToggle');

// shorthand for the control buttons / sliders owned by feature modules
export const $ = id => document.getElementById(id);

// Viewport (clientX/clientY) → a point in `targetCanvas`'s own pixel space,
// scaled off mainCanvas's on-screen size. mainCanvas is always the element
// actually visible/tapped, but the coordinate space callers want can differ:
// calibrate.js samples against readCanvas (the proc-res buffer), while
// links.js hit-tests against mainCanvas itself. Takes targetCanvas as a
// parameter rather than importing readCanvas directly, since camera.js
// already imports mainCanvas from here — importing back would be circular.
export function clientToCanvasPoint(clientX, clientY, targetCanvas, { round = false } = {}) {
  const rect = mainCanvas.getBoundingClientRect();
  const scaleX = targetCanvas.width  / rect.width;
  const scaleY = targetCanvas.height / rect.height;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top)  * scaleY;
  return round ? [Math.round(x), Math.round(y)] : [x, y];
}