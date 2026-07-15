// ── colour helpers ────────────────────────────────────────────────────────────
// This file used to be hsv.js, and used to be much bigger. Detection classifies
// in CIELAB (lab.js) from sampled RGB references; calibration stores RGB;
// configs save RGB. Nothing anywhere speaks HSV any more, so the conversions
// are gone and what's left is display-only: turning a calibration record into
// a CSS colour for swatches and the debug bar.

// RGB→#rrggbb.
export function rgbToHex(r, g, b) {
  return '#' + [r, g, b]
    .map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'))
    .join('');
}

// A calibrated colour's swatch/wash colour — the literal sampled triple that
// detection matches against. Shared by render.js (the media colour wash) and
// ui.js (the piece-list swatches).
export function swatchColor(cal, fallback = '#888') {
  return cal ? rgbToHex(cal.r, cal.g, cal.b) : fallback;
}