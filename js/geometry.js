// ── geometry ──────────────────────────────────────────────────────────────────
// Pure polygon helpers. No DOM, no shared state.
export function matchAndLerp(prev, next, lerp) {
  if (!prev || prev.length !== next.length) return next.map(p => p.slice());
  const out = [];
  for (let i = 0; i < next.length; i++) {
    out.push([
      prev[i][0] + (next[i][0] - prev[i][0]) * lerp,
      prev[i][1] + (next[i][1] - prev[i][1]) * lerp,
    ]);
  }
  return out;
}

// Standard ray-casting point-in-polygon test. `poly` is [[x,y], ...] in the
// same coordinate space as `pt`. Used for hit-testing which piece (if any)
// was tapped — see links.js.
export function pointInPolygon([px, py], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const crosses = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}