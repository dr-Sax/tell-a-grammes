// ── config ──────────────────────────────────────────────────────────────────
// Static configuration + live tuning knobs. Everything here is "the dials";
// per-frame runtime state lives in state.js.

// One entry per calibrated colour. Not "pieces" in the tangram sense any more —
// with print-based markers a single sheet carries several inks, and each ink is
// an independent clip region that its own media pours through.
export const PIECES = [
  { name: 'Colour 1', color: '#e05555' },
  { name: 'Colour 2', color: '#e09055' },
  { name: 'Colour 3', color: '#d4c820' },
  { name: 'Colour 4', color: '#44b844' },
  { name: 'Colour 5', color: '#2299cc' },
  { name: 'Colour 6', color: '#7755dd' },
  { name: 'Colour 7', color: '#cc44aa' },
  { name: 'Colour 8', color: '#ffffff' },
];

export const N = PIECES.length;

// Per-piece media framing sliders. Values live in state.mediaAdjust[i] and are
// applied at draw time in render.js / caption.js.
export const MEDIA_SLIDERS = [
  { key: 'zoom',   label: 'zoom', min: 0.2,   max: 5,   step: 0.05, def: 1 },
  { key: 'rotate', label: 'rot',  min: -180,  max: 180, step: 0.02, def: 0 },
  { key: 'xshift', label: 'x',    min: -1,    max: 1,   step: 0.02, def: 0 },
  { key: 'yshift', label: 'y',    min: -1,    max: 1,   step: 0.02, def: 0 },
];

// Tracking runs at ~this width regardless of capture resolution, decoupling
// display sharpness from detection cost.
export const PROC_TARGET_W = 320;

// Consecutive missed frames tolerated before a colour's overlay is cleared.
export const MISS_GRACE_FRAMES = 8;

// Live tuning, mutated by the sliders.
//
// There used to be seven knobs here: htol, stol, vtol, then lumaW, soft,
// reject, ema. Every one of them was compensating for a model that couldn't
// describe the problem.
//
//   htol/stol/vtol  — three independent tolerance bands around one absolute
//                     colour. Couldn't express "this pixel is MORE like blue-A
//                     than blue-B", which is the only question that matters.
//   lumaW           — a fudge factor for RGB's perceptual non-uniformity. No
//                     single value could serve red-vs-black (needs chroma) and
//                     blue-vs-blue (needs lightness) at once. CIELAB is uniform
//                     by construction, so the weight isn't a choice any more.
//   soft / reject   — absolute distances, in units nobody could reason about.
//                     Now derived from the palette's own scale: how far apart
//                     ITS colours actually are (see quantize.js).
//   ema             — a smoothing rate, not a colour decision. Now a constant.
//
// What's left is the one number that was never a colour dial to begin with:
export const params = {
  // Minimum connected-component area, in proc px. Kills sensor-noise specks
  // without touching real regions. Every component above this survives — that's
  // what preserves counters, spirals, and interlocking shapes.
  minArea: 40,
};

// Detection sliders (the top row of #controls). ui.js generates the markup from
// this array, so min/max/step/default live in exactly one place.
export const TOL_SLIDERS = [
  { key: 'minArea', label: 'Min area', min: 0, max: 2000, step: 10, def: params.minArea },
];