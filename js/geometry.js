// ── geometry ──────────────────────────────────────────────────────────────────
// Pure polygon helpers: convex hull, k-corner fitting, temporally-stable vertex
// smoothing. No DOM, no shared state.

// Andrew's monotone-chain convex hull. pts [[x,y]…] → hull [[x,y]…] CCW.
export function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 &&
           cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 &&
           cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// Greedy max-area k-gon chosen from the hull vertices, returned in CCW order so
// the result is always a simple convex polygon. We know each piece's corner
// count, so this collapses a wobbly hull to its k defining corners.
export function kgonFromHull(hull, k) {
  const m = hull.length;
  if (m <= k) return hull.map(p => p.slice());
  const tri2 = (a, b, c) =>
    Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
  // seed with the two farthest-apart vertices (the polygon's diameter)
  let bi = 0, bj = 1, bd = -1;
  for (let i = 0; i < m; i++)
    for (let j = i + 1; j < m; j++) {
      const dx = hull[i][0] - hull[j][0], dy = hull[i][1] - hull[j][1];
      const d = dx * dx + dy * dy;
      if (d > bd) { bd = d; bi = i; bj = j; }
    }
  const idx = [bi, bj];
  while (idx.length < k) {
    let best = -1, bestGain = -1;
    for (let v = 0; v < m; v++) {
      if (idx.indexOf(v) !== -1) continue;
      let gain = 0;
      for (let e = 0; e < idx.length; e++) {
        const a = hull[idx[e]], b = hull[idx[(e + 1) % idx.length]];
        const g = tri2(a, b, hull[v]);
        if (g > gain) gain = g;
      }
      if (gain > bestGain) { bestGain = gain; best = v; }
    }
    if (best < 0) break;
    idx.push(best);
  }
  idx.sort((a, b) => a - b);   // preserve convex CCW order
  return idx.map(i => hull[i].slice());
}

// Smooth `next` toward `prev`, first rotating next's vertex order to the cyclic
// alignment that best matches prev. Stable correspondence stops corners from
// swapping identities (and "breathing") between frames.
export function matchAndLerp(prev, next, lerp) {
  if (!prev || prev.length !== next.length) return next.map(p => p.slice());
  const k = next.length;
  let bestShift = 0, bestCost = Infinity;
  for (let s = 0; s < k; s++) {
    let cost = 0;
    for (let i = 0; i < k; i++) {
      const n = next[(i + s) % k];
      const dx = n[0] - prev[i][0], dy = n[1] - prev[i][1];
      cost += dx * dx + dy * dy;
    }
    if (cost < bestCost) { bestCost = cost; bestShift = s; }
  }
  const out = [];
  for (let i = 0; i < k; i++) {
    const n = next[(i + bestShift) % k];
    out.push([
      prev[i][0] + (n[0] - prev[i][0]) * lerp,
      prev[i][1] + (n[1] - prev[i][1]) * lerp,
    ]);
  }
  return out;
}