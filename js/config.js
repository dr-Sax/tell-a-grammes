// ── config ──────────────────────────────────────────────────────────────────
// Static configuration + live tuning knobs. Everything here is "the dials";
// per-frame runtime state lives in state.js.

// One entry per calibrated colour. Not "pieces" in the tangram sense any more —
// with the print-based markers, a single sheet may carry several colours, and
// each colour is an independent clip region that its own media pours through.
// The names are just labels for the UI list.
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
// applied at draw time in render.js / caption.js. zoom multiplies the cover-fit
// scale; xshift/yshift offset the media centre as a fraction of the tracked
// colour's bbox (so framing stays anchored as the print moves and resizes).
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
// Still useful: a hand crossing the print shouldn't flicker the media off.
export const MISS_GRACE_FRAMES = 8;

// Live tuning, mutated by the sliders. Kept as one object so every module sees
// edits through the same reference.
//
// htol / stol / vtol are GONE. They described three independent tolerance bands
// around one absolute colour — a model that cannot express "this pixel is more
// like blue-A than blue-B", which is the only question that matters now. The
// four dials that replace them:
export const params = {
  // Weight of brightness relative to chroma in the nearest-colour distance.
  //   1.0 ≈ plain RGB distance — brightness counts fully.
  //   0.0  = chroma only — shading-proof, but light-blue and dark-blue MERGE
  //          and white/grey/black become indistinguishable from each other.
  // For printed markers under steady light, brightness is a SIGNAL, not noise:
  // it's the only axis separating the two Ey Es blues, and the only axis that
  // exists at all for white vs. black. Hence the high default. Wind it down if
  // you ever shoot under raking light and see shadowed areas defect to a darker
  // palette entry.
  lumaW: 1.0,

  // Soft-membership ramp, in colour-distance units. A pixel gets full alpha
  // when its winning colour beats the runner-up by this much; below that it
  // fades. Larger = softer, more forgiving edges (and more rejection of
  // genuinely ambiguous pixels); smaller = crisper, more decisive edges.
  soft: 14,

  // Reject distance. If the nearest palette colour is still this far away, the
  // pixel belongs to nothing (a hand, a shadow, something off-sheet). Generous
  // by default because with a full-frame print almost everything IS a colour.
  reject: 110,

  // Temporal EMA on the per-colour membership fields. Lower = smoother/laggier
  // edges; 1.0 = no smoothing at all (and visible boundary shimmer).
  ema: 0.35,

  // Minimum connected-component area, in proc px. Kills sensor-noise specks
  // without touching the real regions. Every component above this survives.
  minArea: 40,
};

// Detection-tolerance sliders (the top row of #controls). ui.js generates the
// slider markup from this array, so min/max/step/default live in exactly one
// place.
export const TOL_SLIDERS = [
  { key: 'lumaW',   label: 'Luma wt',  min: 0,  max: 2,    step: 0.05, def: params.lumaW },
  { key: 'soft',    label: 'Softness', min: 2,  max: 40,   step: 1,    def: params.soft },
  { key: 'reject',  label: 'Reject',   min: 30, max: 200,  step: 5,    def: params.reject },
  { key: 'ema',     label: 'Smooth',   min: 0.05, max: 1,  step: 0.05, def: params.ema },
  { key: 'minArea', label: 'Min area', min: 0,  max: 2000, step: 10,   def: params.minArea },
];