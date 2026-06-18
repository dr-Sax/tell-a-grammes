// ── colour helpers ────────────────────────────────────────────────────────────
// Single-pixel conversions. The hot per-frame RGB→HSV pass is hand-inlined in
// tracker.js (computeHSV) to avoid per-pixel array allocation.

// RGB→HSV. Returns [h 0-360, s 0-1, v 0-1].
export function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if      (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, max > 0 ? d / max : 0, max];
}

// HSV→#rrggbb.
export function hsvToHex(h, s, v) {
  const f = n => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return '#' + [f(5), f(3), f(1)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Circular hue distance in degrees (0-180).
export function hueDiff360(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}