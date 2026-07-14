// ── lab: CIELAB colour space ──────────────────────────────────────────────────
// Classification moved here from RGB for one reason: RGB Euclidean distance
// forces you to choose, with a knob, how much brightness matters relative to
// hue — and no single choice is right for a whole palette. Red-vs-black are
// separated mainly by lightness AND chroma; white-vs-grey-vs-black ONLY by
// lightness; two similar blues ONLY by lightness. Any weight that fixes one
// case breaks another. That was the `lumaW` slider, and it was a fudge factor
// for a badly chosen space, not a real control.
//
// CIELAB is perceptually uniform: equal distances in it correspond to roughly
// equal perceived colour differences. The lightness/chroma balance is BAKED IN
// — which is exactly the balance we were trying to hand-tune. So plain
// Euclidean ΔE in Lab needs no weight at all, and the slider deletes itself.
//
// Greys sit on the a*=b*=0 axis and separate purely by L*, colours fan out from
// it. One metric, every case.

// ── single-colour conversion ──────────────────────────────────────────────────
// sRGB (0-255) → linear → XYZ (D65) → Lab. Returns [L, a, b].
// L* is 0-100; a*/b* are roughly -128..127.

const XN = 0.95047, YN = 1.00000, ZN = 1.08883;   // D65 white point

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function fLab(t) {
  return t > 0.008856451679035631            // (6/29)^3
    ? Math.cbrt(t)
    : t * 7.787037037037035 + 0.13793103448275862;   // (1/3)(29/6)^2 t + 4/29
}

export function rgb2lab(r, g, b) {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);

  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / XN;
  const y = (0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl) / YN;
  const z = (0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / ZN;

  const fx = fLab(x), fy = fLab(y), fz = fLab(z);

  return [
    116 * fy - 16,        // L*
    500 * (fx - fy),      // a*
    200 * (fy - fz),      // b*
  ];
}

// Squared ΔE76. Squared because argmin over d² picks the same winner as argmin
// over d, and we only need the actual root when we compare margins.
export function dE2(L1, a1, b1, L2, a2, b2) {
  const dL = L1 - L2, da = a1 - a2, db = b1 - b2;
  return dL * dL + da * da + db * db;
}

// ── the RGB cube → Lab table ──────────────────────────────────────────────────
// Converting every pixel to Lab every frame would be ~77k cbrt() calls — the
// one genuinely expensive thing in this space. Instead we precompute Lab for a
// 5-bit RGB cube ONCE, at module load, and every per-pixel lookup afterwards is
// an array read.
//
// 5 bits/channel = 32 levels = 32768 cells. Quantisation error is ~4/255 per
// channel, which lands under 1 ΔE — well below camera sensor noise, and far
// below the separation between any two inks you'd print. The table is 393 KB
// and is built in a few milliseconds at startup.

const BITS = 5;
const LEVELS = 1 << BITS;                  // 32
export const CUBE = LEVELS * LEVELS * LEVELS;     // 32768
const SHIFT = 8 - BITS;                    // 3

// Flat [L,a,b, L,a,b, …] for every cube cell. Index a cell with cubeIndex().
export const labCube = new Float32Array(CUBE * 3);

(function buildLabCube() {
  const step = 255 / (LEVELS - 1);
  let i = 0;
  for (let ri = 0; ri < LEVELS; ri++) {
    for (let gi = 0; gi < LEVELS; gi++) {
      for (let bi = 0; bi < LEVELS; bi++, i += 3) {
        const [L, a, b] = rgb2lab(ri * step, gi * step, bi * step);
        labCube[i] = L; labCube[i + 1] = a; labCube[i + 2] = b;
      }
    }
  }
})();

// 8-bit RGB → cube cell index.
export function cubeIndex(r, g, b) {
  return ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
}