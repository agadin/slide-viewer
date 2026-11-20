/**
 * Filter maths shared by the GPU shader (gl.ts) and the CPU reference path (snapshots without WebGL,
 * tests). Pure TS, no DOM. Owner: filters.
 *
 * Per-pixel order (the shader in gl.ts mirrors `applyPixel` exactly):
 *   1. unsharp mask (screen-space 3×3 Gaussian at `radius` px spacing)
 *   2. stain matrix in optical-density space (separation / recombination / Macenko normalisation); OD is measured
 *      against the slide's background I0 when known, and the result is re-exposed against white
 *   3. levels (per-channel black/white points)
 *   4. gamma            out = in^(1/gamma)   (gamma > 1 brightens mid-tones)
 *   5. brightness (+b/2), contrast ((c - .5) * 4^contrast + .5)
 *   6. colour matrix (saturation, then hue rotation; CSS filter matrices)
 *   7. grayscale (Rec. 709 luma), 8. invert
 */
import type { FilterParams, StainAnalysis, StainMode } from "../types";

export type Vec3 = [number, number, number];
/** 3×3 matrix, row-major */
export type Mat3 = number[];

// ---------------------------------------------------------------- optical density

/** smallest intensity used in OD maths (1/255), so OD stays finite: max OD = ln 255 ≈ 5.54 */
export const I_MIN = 1 / 255;
/** optical density of an intensity 0..1 (natural log, I0 = 1) */
export const toOd = (c: number) => -Math.log(Math.max(c, I_MIN));
export const fromOd = (d: number) => Math.exp(-d);

// ---------------------------------------------------------------- stain vectors

/** Ruifrok & Johnston reference stain OD vectors (rows: stains), as in ImageJ / QuPath */
export const REF_VECTORS: Record<Exclude<StainMode, "none">, number[][]> = {
  he: [
    [0.65, 0.704, 0.286],
    [0.072, 0.99, 0.105],
  ],
  hdab: [
    [0.65, 0.704, 0.286],
    [0.268, 0.57, 0.776],
  ],
};
export const STAIN_NAMES: Record<Exclude<StainMode, "none">, string[]> = {
  he: ["Haematoxylin", "Eosin"],
  hdab: ["Haematoxylin", "DAB"],
};
/**
 * Target of normalisation: the textbook (Ruifrok) H&E colours with Macenko's reference 99th-percentile
 * concentrations. Decision: Macenko's own reference vectors render eosin salmon-brown on screen, so the
 * Ruifrok colours are used as the target.
 */
export const NORM_REF = {
  vectors: [
    [0.65, 0.704, 0.286],
    [0.072, 0.99, 0.105],
  ],
  maxC: [1.9705, 1.0308],
};

/**
 * Per-stain scale factors for normalisation. The analysis runs on a <= 2k px overview, where concentrations are
 * lower than at full resolution (blurring), so matching the absolute 99th percentiles would over-darken. Decision:
 * correct the H:E BALANCE (ratios divided by their geometric mean) and clamp each factor to [0.5, 2].
 */
export function normScales(maxC: number[]): [number, number] {
  const r0 = NORM_REF.maxC[0] / Math.max(maxC[0], 1e-3);
  const r1 = NORM_REF.maxC[1] / Math.max(maxC[1], 1e-3);
  const g = Math.sqrt(r0 * r1);
  const c = (x: number) => Math.max(0.5, Math.min(2, x));
  return [c(r0 / g), c(r1 / g)];
}

// ---------------------------------------------------------------- small linear algebra

export const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: number[], b: number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: number[]): Vec3 => {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
/** angle between two vectors, degrees */
export const angleDeg = (a: number[], b: number[]) => (Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * 180) / Math.PI;

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}
export const mulVec = (m: Mat3, v: number[]): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
export const diag = (d: number[]): Mat3 => [d[0], 0, 0, 0, d[1], 0, 0, 0, d[2]];
export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
export function det3(m: Mat3) {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}
export function inv3(m: Mat3): Mat3 | null {
  const d = det3(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return null;
  const i = 1 / d;
  return [
    (m[4] * m[8] - m[5] * m[7]) * i,
    (m[2] * m[7] - m[1] * m[8]) * i,
    (m[1] * m[5] - m[2] * m[4]) * i,
    (m[5] * m[6] - m[3] * m[8]) * i,
    (m[0] * m[8] - m[2] * m[6]) * i,
    (m[2] * m[3] - m[0] * m[5]) * i,
    (m[3] * m[7] - m[4] * m[6]) * i,
    (m[1] * m[6] - m[0] * m[7]) * i,
    (m[0] * m[4] - m[1] * m[3]) * i,
  ];
}

/**
 * Stain basis: a matrix whose COLUMNS are the unit stain vectors. Two stains get a third "residual"
 * column (their cross product), so the matrix is invertible and every OD splits into 3 concentrations.
 */
export function stainBasis(rows: number[][]): Mat3 | null {
  if (rows.length < 2) return null;
  const a = unit(rows[0]);
  const b = unit(rows[1]);
  let c: Vec3 = rows.length >= 3 ? unit(rows[2]) : cross(a, b);
  if (norm(c) < 1e-6) return null;
  c = unit(c);
  return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
}

/** concentrations of an OD vector for a stain basis: c = basis⁻¹ · od (3 values; the 3rd is the residual for 2 stains) */
export function concentrations(basisInv: Mat3, od: number[]): Vec3 {
  return mulVec(basisInv, od);
}

/** custom vectors are valid when there are 2–3 non-zero, non-parallel rows of 3 finite numbers */
export function validVectors(v: number[][] | null | undefined): v is number[][] {
  if (!v || v.length < 2 || v.length > 3) return false;
  if (!v.every((r) => r.length === 3 && r.every((x) => Number.isFinite(x)) && norm(r) > 1e-6)) return false;
  return stainBasis(v) != null && inv3(stainBasis(v)!) != null;
}

/**
 * The OD-space matrix for stain separation / recombination / normalisation, or null when none is on.
 * - separation (stain.mode he|hdab): deconvolve with stain.vectors (custom) or the Ruifrok reference;
 *   channel -1 recombines all stains (dropping the residual), channel k shows stain k alone in its own colour.
 * - normalise (needs analysis vectors + maxC): deconvolve with the slide's estimated vectors, scale each
 *   concentration (normScales: H:E balance of the reference), recombine with the reference H&E vectors (Macenko-style).
 *   With a separation mode on as well, its channel choice applies to the normalised stains.
 */
export function stainMatrix(p: FilterParams, a: StainAnalysis | null): Mat3 | null {
  const st = p.stain;
  const canNorm = p.normalize && !!a && validVectors(a.vectors) && !!a.maxC && a.maxC.length >= 2;
  const sep = st.mode !== "none";
  if (!canNorm && !sep) return null;
  let src: number[][];
  let dst: number[][];
  let scale: number[];
  if (canNorm) {
    src = a!.vectors!.slice(0, 2);
    dst = NORM_REF.vectors;
    scale = [...normScales(a!.maxC!), 0];
  } else {
    src = validVectors(st.vectors) ? st.vectors : REF_VECTORS[st.mode as Exclude<StainMode, "none">];
    dst = src;
    scale = [1, 1, src.length >= 3 ? 1 : 0];
  }
  if (sep && st.channel >= 0 && st.channel < 3) scale = scale.map((s, i) => (i === st.channel ? s : 0));
  const bs = stainBasis(src);
  const bd = stainBasis(dst);
  const bsi = bs && inv3(bs);
  if (!bd || !bsi) return null;
  return mul3(mul3(bd, diag(scale)), bsi);
}

// ---------------------------------------------------------------- colour matrices (CSS Filter Effects spec)

export function saturateMatrix(s: number): Mat3 {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
}
export function hueMatrix(deg: number): Mat3 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
}
export const LUMA: Vec3 = [0.2126, 0.7152, 0.0722];

// ---------------------------------------------------------------- uniforms

/** Everything the shader needs, precomputed from FilterParams (+ the slide's analysis for normalisation). */
export interface FilterUniforms {
  stainOn: boolean;
  stainM: Mat3;
  /** background illumination for OD (Beer–Lambert I0), from the slide's analysis; white when unknown */
  i0: Vec3;
  levelsOn: boolean;
  black: Vec3;
  white: Vec3;
  gamma: number;
  brightness: number;
  /** contrast factor (4^contrast) */
  contrast: number;
  colorOn: boolean;
  colorM: Mat3;
  grayscale: boolean;
  invert: boolean;
  /** unsharp amount (0 = off) and radius in screen px */
  sharpen: number;
  sharpenRadius: number;
}

const finite = (x: number, d: number) => (Number.isFinite(x) ? x : d);

export function uniformsFor(p: FilterParams, a: StainAnalysis | null = null): FilterUniforms {
  const sm = stainMatrix(p, a);
  const sat = finite(p.saturation, 0);
  const hue = finite(p.hue, 0);
  const colorOn = Math.abs(sat) > 1e-4 || Math.abs(hue) > 1e-3;
  const lv = p.levels;
  const levelsOn = !!lv && [0, 1, 2].some((i) => Math.abs(lv.black[i]) > 1e-4 || Math.abs(lv.white[i] - 1) > 1e-4);
  return {
    stainOn: !!sm,
    stainM: sm ?? IDENTITY,
    i0: a?.background ? [a.background[0], a.background[1], a.background[2]] : [1, 1, 1],
    levelsOn,
    black: lv ? [lv.black[0], lv.black[1], lv.black[2]] : [0, 0, 0],
    white: lv ? [lv.white[0], lv.white[1], lv.white[2]] : [1, 1, 1],
    gamma: Math.max(0.05, finite(p.gamma, 1)),
    brightness: finite(p.brightness, 0),
    contrast: Math.pow(4, finite(p.contrast, 0)),
    colorOn,
    colorM: colorOn ? mul3(hueMatrix(hue), saturateMatrix(1 + sat)) : IDENTITY,
    grayscale: !!p.grayscale,
    invert: !!p.invert,
    sharpen: Math.max(0, finite(p.sharpen, 0)),
    sharpenRadius: Math.max(0.25, finite(p.sharpenRadius, 1)),
  };
}

/** true when the uniforms leave every pixel unchanged (the pipeline then skips the GPU pass entirely) */
export function isNeutral(u: FilterUniforms): boolean {
  return (
    !u.stainOn &&
    !u.levelsOn &&
    Math.abs(u.gamma - 1) < 1e-4 &&
    Math.abs(u.brightness) < 1e-4 &&
    Math.abs(u.contrast - 1) < 1e-4 &&
    !u.colorOn &&
    !u.grayscale &&
    !u.invert &&
    u.sharpen < 1e-4
  );
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** the point operations (steps 2–8) on one pixel, channels 0..1. `c` is modified and returned. */
export function applyPixel(u: FilterUniforms, c: number[]): number[] {
  if (u.stainOn) {
    const od = mulVec(u.stainM, [0, 1, 2].map((i) => Math.max(0, toOd(c[i]) - toOd(u.i0[i]))));
    for (let i = 0; i < 3; i++) c[i] = fromOd(Math.max(0, od[i]));
  }
  if (u.levelsOn) for (let i = 0; i < 3; i++) c[i] = clamp01((c[i] - u.black[i]) / Math.max(1e-4, u.white[i] - u.black[i]));
  const ig = 1 / u.gamma;
  for (let i = 0; i < 3; i++) {
    let v = Math.pow(Math.max(c[i], 0), ig);
    v += u.brightness * 0.5;
    v = (v - 0.5) * u.contrast + 0.5;
    c[i] = clamp01(v);
  }
  if (u.colorOn) {
    const m = mulVec(u.colorM, c);
    for (let i = 0; i < 3; i++) c[i] = clamp01(m[i]);
  }
  if (u.grayscale) {
    const l = dot(LUMA, c);
    c[0] = c[1] = c[2] = l;
  }
  if (u.invert) for (let i = 0; i < 3; i++) c[i] = 1 - c[i];
  return c;
}

/**
 * CPU reference of the whole pipeline on RGBA bytes (same maths as the shader; used when WebGL is
 * unavailable and in tests). `pxScale` multiplies the sharpen radius (device px per CSS px).
 */
export function applyToRgba(src: Uint8ClampedArray | Uint8Array, w: number, h: number, u: FilterUniforms, pxScale = 1): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(src.length);
  const r = Math.max(1, Math.round(u.sharpenRadius * pxScale));
  const at = (x: number, y: number, ch: number) => {
    const xx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const yy = y < 0 ? 0 : y >= h ? h - 1 : y;
    return src[(yy * w + xx) * 4 + ch] / 255;
  };
  const c = [0, 0, 0];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let v = src[o + ch] / 255;
        if (u.sharpen > 0) {
          const b =
            (4 * v +
              2 * (at(x - r, y, ch) + at(x + r, y, ch) + at(x, y - r, ch) + at(x, y + r, ch)) +
              at(x - r, y - r, ch) + at(x + r, y - r, ch) + at(x - r, y + r, ch) + at(x + r, y + r, ch)) / 16;
          v = clamp01(v + u.sharpen * (v - b));
        }
        c[ch] = v;
      }
      applyPixel(u, c);
      out[o] = Math.round(c[0] * 255);
      out[o + 1] = Math.round(c[1] * 255);
      out[o + 2] = Math.round(c[2] * 255);
      out[o + 3] = src[o + 3];
    }
  return out;
}
