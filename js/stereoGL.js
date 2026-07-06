// ── stereoGL: WebGL barrel-distortion compositor for the stereo view ──────────
// Canvas 2D is affine-only (translate/scale/rotate/skew), so it can't warp —
// barrel distortion is a nonlinear per-pixel remap. This module owns the stereo
// canvas via WebGL: uploads mainCanvas as a texture, then draws each eye's half
// through a fragment shader doing per-eye horizontal shift, eye rotation, a
// barrel term, a fill/zoom, and a cover-fit of the (4:3) source into each eye.
//
// Barrel, correctly: the lenses in a phone viewer pincushion the image, so the
// screen image must be barrel-pre-distorted to cancel it. Barrel = f>1 at the
// edges (f = 1 + k·r²) so the periphery samples *beyond* the source → the
// rounded black corners the lens fills in. (The reciprocal, f = 1/(1+k·r²),
// does the opposite: magnifies centre, crops edges — that was the earlier bug.)
//
// Fullscreen fill: each eye's on-screen slice isn't 4:3, so the source is
// cover-fit into the eye in the shader (uCover) and the canvas is sized to its
// own on-screen box by the caller — no object-fit crop, no aspect letterbox.
// Only black left is the intended distortion corners.

let gl = null, prog = null, tex = null, uni = {};

const VERT = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform float uK1, uK2;      // barrel coefficients (r^2, r^4)
uniform float uShift;        // horizontal eye alignment, fraction of eye width
uniform float uAngle;        // eye rotation applied on screen, radians
uniform float uAspect;       // eye aspect (eyeW/eyeH) -> round distortion
uniform float uFill;         // >1 zooms each eye in, pushing black corners off-eye
uniform vec2  uCover;        // cover-fit scale, source -> eye (kills aspect bars)
varying vec2 vUV;
void main() {
  vec2 p = (vUV - 0.5) * 2.0;                 // [-1,1] across the eye
  vec2 q = vec2(p.x * uAspect, p.y);          // aspect-corrected radius
  float r2 = dot(q, q);
  float f = 1.0 + uK1 * r2 + uK2 * r2 * r2;   // barrel: rounded corners at the edges
  vec2 cp = p * f / uFill;                    // distort, then zoom to fill
  cp.x -= uShift * 2.0;                       // horizontal alignment (1 unit = half-width)
  cp = mat2(cos(uAngle), -sin(uAngle), sin(uAngle), cos(uAngle)) * cp;  // undo +uAngle
  cp *= uCover;                               // cover-fit the 4:3 source into this eye
  vec2 uv = cp * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);  // intended barrel corners
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
// true on success; false if WebGL is unavailable.
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
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  for (const k of ['uK1','uK2','uShift','uAngle','uAspect','uFill','uCover'])
    uni[k] = gl.getUniformLocation(prog, k);
  return true;
}

// Composite `source` into the double-wide canvas. srcW/srcH are the source
// (mainCanvas) dims; eyeW/eyeH are each eye's on-screen pixel size (half the
// canvas backing store). Both eyes sample the same source.
export function renderStereoGL(source, srcW, srcH, eyeW, eyeH, { shiftL, shiftR, angle, k1, k2, fill }) {
  if (!gl) return;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

  const srcA = srcW / srcH, eyeA = eyeW / eyeH;
  // cover: sample a sub-region of the source so it fills the eye with no bars.
  const cover = eyeA > srcA ? [1, srcA / eyeA] : [eyeA / srcA, 1];

  gl.uniform1f(uni.uK1, k1);
  gl.uniform1f(uni.uK2, k2 || 0);
  gl.uniform1f(uni.uAspect, eyeA);
  gl.uniform1f(uni.uFill, fill || 1);
  gl.uniform2f(uni.uCover, cover[0], cover[1]);

  gl.viewport(0, 0, eyeW, eyeH);              // left eye
  gl.uniform1f(uni.uShift, shiftL);
  gl.uniform1f(uni.uAngle, angle);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.viewport(eyeW, 0, eyeW, eyeH);           // right eye
  gl.uniform1f(uni.uShift, shiftR);
  gl.uniform1f(uni.uAngle, -angle);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}