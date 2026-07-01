// ── DOM references ────────────────────────────────────────────────────────────
// One place to resolve the elements declared in index.html. Module scripts are
// deferred, so the DOM is fully parsed by the time this evaluates.

export const mainCanvas  = document.getElementById('mainCanvas');
export const mainCtx     = mainCanvas.getContext('2d', { willReadFrequently: false });
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