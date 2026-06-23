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