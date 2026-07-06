// ── stereoGL: WebGL barrel-distortion compositor for the stereo view ──────────
// Canvas 2D can only do affine transforms (translate/scale/rotate/skew), so the
// old clip+translate+rotate stereo path physically couldn't warp the image —
// barrel distortion is a nonlinear per-pixel remap. This module takes over the
// stereo canvas with a WebGL context and does the whole side-by-side composite
// on the GPU: uploads mainCanvas as a texture, then draws each eye's half
// through a fragment shader that applies per-eye horizontal shift, eye rotation,
// and a tunable barrel term.
//
// Why barrel at all: the lenses in a phone stereo viewer (Cardboard et al.)
// pincushion the image, so the app pre-distorts with the inverse (barrel) for
// the view through the lens to come out straight. Strength is one coefficient
// (state.stereoDistort): 0 = flat (identical to the old output), + = barrel,
// − = pincushion.
//
// Shift/angle match the OLD path exactly. Old per eye: screen = R(+a)·src + shift.
// So to find the source texel for a screen point we undo it: src = R(−a)·(screen − shift).
// The barrel warp is applied first (it lives in screen space, centred on the
// lens axis); its output is then treated as "screen" for that un-shift/un-rotate.

let gl = null, prog = null, tex = null, uni = {};

const VERT = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;              // 0..1 across the quad
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform float uK1, uK2;      // barrel coefficients (r^2 and r^4 terms)
uniform float uShift;        // horizontal content shift, fraction of eye width
uniform float uAngle;        // eye rotation applied on screen, radians
uniform float uAspect;       // MW/MH — makes the radius isotropic on screen
varying vec2 vUV;
void main() {
  vec2 p = (vUV - 0.5) * 2.0;                 // centred screen coord, ~[-1,1]
  vec2 q = vec2(p.x * uAspect, p.y);          // aspect-corrected for round distortion
  float r2 = dot(q, q);
  // Divide (not multiply) so the factor stays positive for any k — the slider
  // can never invert the image. uK1>0 -> f<1 at the edges -> samples pulled
  // toward centre -> straight lines bow outward -> barrel.
  float f = 1.0 / (1.0 + uK1 * r2 + uK2 * r2 * r2);
  vec2 cp = p * f;                            // barrel-warped screen coord
  cp.x -= uShift * 2.0;                       // undo horizontal shift (1 unit = half-width)
  // undo the +uAngle rotation: R(-uAngle), column-major mat2
  cp = mat2(cos(uAngle), -sin(uAngle), sin(uAngle), cos(uAngle)) * cp;
  vec2 uv = cp * 0.5 + 0.5;                   // back to 0..1 in source (mainCanvas) space
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);  // black where the warp reaches outside the frame
    return;
  }
  gl_FragColor = texture2D(uTex, uv);
}`;

function compile(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error('shader: ' + gl.getShaderInfoLog(sh));
  return sh;
}

// Call once before the first render (lazily, from the stereo toggle). Returns
// true on success; false if WebGL is unavailable — caller can surface that and
// leave stereo disabled rather than throwing mid-frame.
export function initStereoGL(canvas) {
  gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: false });
  if (!gl) return false;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error('link: ' + gl.getProgramInfoLog(prog));
  } catch (e) { gl = null; console.warn('[stereoGL]', e.message); return false; }

  gl.useProgram(prog);

  // full-clip-space quad; glViewport restricts it to each eye's half
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // canvas 2d origin is top-left; flip so texel (0,0) lands where we expect
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  for (const k of ['uK1', 'uK2', 'uShift', 'uAngle', 'uAspect'])
    uni[k] = gl.getUniformLocation(prog, k);
  return true;
}

// Composite `source` (mainCanvas) into the double-wide stereo canvas. Both eyes
// sample the same source; each is drawn into its own MW-wide viewport half with
// its own shift/angle. k1/k2 are shared (the lens correction is the same per eye).
export function renderStereoGL(source, MW, MH, { shiftL, shiftR, angle, k1, k2 }) {
  if (!gl) return;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

  gl.uniform1f(uni.uK1, k1);
  gl.uniform1f(uni.uK2, k2 || 0);
  gl.uniform1f(uni.uAspect, MW / MH);

  gl.viewport(0, 0, MW, MH);            // left eye
  gl.uniform1f(uni.uShift, shiftL);
  gl.uniform1f(uni.uAngle, angle);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.viewport(MW, 0, MW, MH);           // right eye
  gl.uniform1f(uni.uShift, shiftR);
  gl.uniform1f(uni.uAngle, -angle);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}