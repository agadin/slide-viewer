/**
 * WebGL (1) renderer for the filter pipeline: one full-screen pass that reads a source image (the
 * OpenSeadragon canvas, or a snapshot canvas) as a texture and writes the filtered result. The fragment
 * shader mirrors math.ts `applyPixel` / `applyToRgba` step for step. Owner: filters.
 */
import { transpose, type FilterUniforms, type Mat3 } from "./math";

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_img;
uniform vec2 u_texel;
uniform float u_sharpen;
uniform float u_radius;
uniform bool u_stainOn;
uniform mat3 u_stainM;
uniform vec3 u_odI0;
uniform bool u_levelsOn;
uniform vec3 u_black;
uniform vec3 u_white;
uniform float u_invGamma;
uniform float u_brightness;
uniform float u_contrast;
uniform bool u_colorOn;
uniform mat3 u_colorM;
uniform bool u_gray;
uniform bool u_invert;

vec3 tex(vec2 d) { return texture2D(u_img, v_uv + d).rgb; }

void main() {
  vec4 px = texture2D(u_img, v_uv);
  vec3 c = px.rgb;
  if (u_sharpen > 0.0) {
    vec2 dx = vec2(u_texel.x * u_radius, 0.0);
    vec2 dy = vec2(0.0, u_texel.y * u_radius);
    vec3 b = 4.0 * c
      + 2.0 * (tex(-dx) + tex(dx) + tex(-dy) + tex(dy))
      + tex(-dx - dy) + tex(dx - dy) + tex(-dx + dy) + tex(dx + dy);
    b /= 16.0;
    c = clamp(c + u_sharpen * (c - b), 0.0, 1.0);
  }
  if (u_stainOn) {
    vec3 od = max(-log(max(c, vec3(1.0 / 255.0))) - u_odI0, vec3(0.0));
    od = u_stainM * od;
    c = exp(-max(od, vec3(0.0)));
  }
  if (u_levelsOn) c = clamp((c - u_black) / max(u_white - u_black, vec3(1e-4)), 0.0, 1.0);
  c = pow(max(c, vec3(0.0)), vec3(u_invGamma));
  c += u_brightness * 0.5;
  c = clamp((c - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  if (u_colorOn) c = clamp(u_colorM * c, 0.0, 1.0);
  if (u_gray) c = vec3(dot(c, vec3(0.2126, 0.7152, 0.0722)));
  if (u_invert) c = 1.0 - c;
  gl_FragColor = vec4(c, px.a);
}`;

type Loc = WebGLUniformLocation | null;

export class FilterRenderer {
  readonly gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private buf: WebGLBuffer;
  private loc: Record<string, Loc> = {};
  private texW = 0;
  private texH = 0;

  /** throws when WebGL is unavailable */
  constructor(readonly canvas: HTMLCanvasElement, opts: { preserve?: boolean } = {}) {
    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: !!opts.preserve,
    }) as WebGLRenderingContext | null;
    if (!gl) throw new Error("WebGL is not available");
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`filter shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`filter program: ${gl.getProgramInfoLog(p)}`);
    this.prog = p;
    gl.useProgram(p);
    for (const n of [
      "u_img", "u_texel", "u_sharpen", "u_radius", "u_stainOn", "u_stainM", "u_odI0", "u_levelsOn", "u_black", "u_white",
      "u_invGamma", "u_brightness", "u_contrast", "u_colorOn", "u_colorM", "u_gray", "u_invert",
    ])
      this.loc[n] = gl.getUniformLocation(p, n);
    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(p, "a_pos");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.uniform1i(this.loc.u_img, 0);
  }

  /**
   * Filter `src` (w × h device px) into this renderer's canvas, resizing it to match.
   * `pxScale`: device px per CSS px (the sharpen radius is in CSS px).
   */
  render(src: TexImageSource, w: number, h: number, u: FilterUniforms, pxScale = 1) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.texW === w && this.texH === h) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
    else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      this.texW = w;
      this.texH = h;
    }
    const L = this.loc;
    const m3 = (l: Loc, m: Mat3) => gl.uniformMatrix3fv(l, false, new Float32Array(transpose(m))); // GLSL is column-major
    gl.uniform2f(L.u_texel, 1 / w, 1 / h);
    gl.uniform1f(L.u_sharpen, u.sharpen);
    gl.uniform1f(L.u_radius, Math.max(1, u.sharpenRadius * pxScale));
    gl.uniform1i(L.u_stainOn, u.stainOn ? 1 : 0);
    m3(L.u_stainM, u.stainM);
    gl.uniform3f(L.u_odI0, -Math.log(Math.max(u.i0[0], 1 / 255)), -Math.log(Math.max(u.i0[1], 1 / 255)), -Math.log(Math.max(u.i0[2], 1 / 255)));
    gl.uniform1i(L.u_levelsOn, u.levelsOn ? 1 : 0);
    gl.uniform3fv(L.u_black, u.black);
    gl.uniform3fv(L.u_white, u.white);
    gl.uniform1f(L.u_invGamma, 1 / u.gamma);
    gl.uniform1f(L.u_brightness, u.brightness);
    gl.uniform1f(L.u_contrast, u.contrast);
    gl.uniform1i(L.u_colorOn, u.colorOn ? 1 : 0);
    m3(L.u_colorM, u.colorM);
    gl.uniform1i(L.u_gray, u.grayscale ? 1 : 0);
    gl.uniform1i(L.u_invert, u.invert ? 1 : 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteTexture(this.tex);
    gl.deleteBuffer(this.buf);
    gl.deleteProgram(this.prog);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
