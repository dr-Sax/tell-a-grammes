// ── config ──────────────────────────────────────────────────────────────────
// Static configuration + live tuning knobs. Everything here is "the dials";
// per-frame runtime state lives in state.js.

// One entry per physical tangram piece. `shape` is currently unused by
// detection (boundary tracing doesn't need a corner count) but is kept around
// in case it's useful later for per-piece cosmetics or future shape-aware
// features (e.g. same-color piece merging).
export const PIECES = [
  { name: 'Piece 1', color: '#e05555', shape: 'triangle' },
  { name: 'Piece 2', color: '#e09055', shape: 'triangle' },
  { name: 'Piece 3', color: '#d4c820', shape: 'triangle' },
  { name: 'Piece 4', color: '#44b844', shape: 'triangle' },
  { name: 'Piece 5', color: '#2299cc', shape: 'triangle' },
  { name: 'Piece 6', color: '#7755dd', shape: 'square' },
  { name: 'Piece 7', color: '#cc44aa', shape: 'parallelogram' },
];

export const N = PIECES.length;

// Per-piece media framing sliders. Values live in state.mediaAdjust[i] and are
// applied at draw time in render.js / caption.js. zoom multiplies the cover-fit
// scale; xshift/yshift offset the media centre as a fraction of the tracked
// piece's bbox (so framing stays anchored as the piece moves and resizes).
export const MEDIA_SLIDERS = [
  { key: 'zoom',   label: 'zoom', min: 0.2,   max: 5,   step: 0.05, def: 1 },
  { key: 'rotate', label: 'rot',  min: -180,  max: 180, step: 0.02, def: 0 },
  { key: 'xshift', label: 'x',    min: -1,    max: 1,   step: 0.02, def: 0 },
  { key: 'yshift', label: 'y',    min: -1,    max: 1,   step: 0.02, def: 0 },
];

// Number of points in the resampled boundary polygon for every piece,
// regardless of shape. Evenly spaced by arc length around the traced outer
// perimeter. Higher = smoother outline / more clip-path detail, at a small
// per-frame cost (resampling + lerp + clip-path drawing all scale with this).
// 48-64 is plenty for tangram-piece-sized overlays; rarely worth going past
// 100 since the visual smoothness gain flattens out well before then.
export const BOUNDARY_N = 64;

// Hull-vertex smoothing factor (lerp toward the new shape each frame).
export const LERP = 0.3;

// Tracking runs at ~this width regardless of capture resolution, decoupling
// display sharpness from detection cost.
export const PROC_TARGET_W = 320;

// Morphology radius. Bordered pieces get NO opening (it erodes thin rings); we
// only close, to bridge small gaps in the ring (glare / anti-aliasing).
export const CLOSE_R = 2;

// How far (as a fraction of the proc-frame width) a piece's blob is allowed
// to jump between frames while continuously tracked, before detectPiece
// treats "something matched over there" as a miss rather than snapping to
// it. This is the main defense against a hand — or a stray patch of similar
// fluorescence — hijacking a piece's tracking just by being the bigger blob
// this frame. Physical pieces don't teleport, so anything far from the last
// known position is ignored until re-acquired after MISS_GRACE_FRAMES.
export const MAX_JUMP_FRAC = 0.35;

// Consecutive missed frames tolerated before a piece's overlay is cleared and
// its last-known position forgotten (triggering a fresh largest-blob
// re-acquisition next time something is found). This grace period is what
// stops a hand briefly passing over a piece from flickering its overlay off.
export const MISS_GRACE_FRAMES = 8;

// Live tuning, mutated by the sliders. Kept as one object so every module sees
// edits through the same reference.
export const params = {
  htol: 12,     // hue tolerance in OpenCV 0-180 units (×2 = degrees)
  stol: 33,    // saturation tolerance on 0-255 (÷255 = fraction)
  vtol:75,    // value tolerance on 0-255 (÷255 = fraction)
  minArea: 20, // min connected-component area in proc px (a ring is small)
};