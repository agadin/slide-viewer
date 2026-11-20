/**
 * Stain analysis on a low-resolution overview (≤ ~2k px, RGBA bytes). Pure TS, unit-tested. Owner: filters.
 *
 *  - tissue mask: optical density threshold (any channel OD ≥ β = 0.15), ignoring transparent padding and
 *    near-black pixels (pen, slide edge).
 *  - Macenko stain-vector estimation (eigenvectors of the OD covariance, extreme angles at the 1st/99th percentile).
 *  - stain-type detection: H&E vs H-DAB/IHC vs special stains (PAS, trichrome, silver), from hue / OD statistics of
 *    tissue pixels and the angles of the estimated vectors to the reference vectors, with a confidence 0..1.
 *  - auto levels / gamma from the tissue-only histogram (background only supplies the white point = white balance).
 * Normalisation itself is a 3×3 OD matrix built in math.ts (stainMatrix) from `vectors` + `maxC`.
 */
import type { StainAnalysis, StainType } from "../types";
import { REF_VECTORS, angleDeg, dot, inv3, mulVec, stainBasis, toOd, unit, type Vec3 } from "./math";

export const OD_BETA = 0.15;
/** OD above which every channel counts as "black" (I < ~13/255): pen marks, slide edges */
export const OD_BLACK = 3;

// ---------------------------------------------------------------- sampling

export interface TissueSample {
  /** tissue pixels: OD relative to the background illumination `i0` (3 per pixel) and RGB 0..255 (3 per pixel) */
  od: Float32Array;
  rgb: Uint8Array;
  n: number;
  /** background pixel RGB (subsampled; for the white point) */
  bg: Uint8Array;
  nBg: number;
  /** opaque pixels looked at (after subsampling) */
  total: number;
  /** estimated background (illumination) per channel, 0..1 (Beer–Lambert I0) */
  i0: Vec3;
}

/** OD of a 0..255 value relative to an illumination i0 (0..1), never negative */
const odRel = (v: number, i0: number) => Math.max(0, toOd(v / 255) - toOd(i0));

/** is this RGB (0..255) tissue? OD is measured against the background `i0` (default: pure white). */
export function isTissue(r: number, g: number, b: number, beta = OD_BETA, i0: number[] = [1, 1, 1]): boolean {
  const o0 = odRel(r, i0[0]), o1 = odRel(g, i0[1]), o2 = odRel(b, i0[2]);
  const mx = Math.max(o0, o1, o2);
  const mn = Math.min(toOd(r / 255), toOd(g / 255), toOd(b / 255));
  return mx >= beta && mn < OD_BLACK;
}

/**
 * The slide background (glass + illumination): the most common bright luminance among opaque pixels, then the
 * median of each channel around it. Scanners often record glass at ~220/255, which a fixed white of 255 would count
 * as tissue. Falls back to white when no bright background exists (e.g. tissue covers the whole overview).
 */
export function estimateBackground(rgba: ArrayLike<number>, w: number, h: number, step = 1): Vec3 {
  const hist = new Uint32Array(256);
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const o = (y * w + x) * 4;
      if (rgba[o + 3] < 128) continue;
      hist[Math.round(0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2])]++;
    }
  let total = 0;
  for (const c of hist) total += c;
  // bright (≥ 175) local maxima of the smoothed histogram; take the BRIGHTEST one that is substantial, so pale
  // tissue covering most of the overview doesn't win over the glass around it
  const sm = (l: number) => hist[l - 2] + hist[l - 1] + hist[l] + (l < 255 ? hist[l + 1] : 0) + (l < 254 ? hist[l + 2] : 0);
  let peak = 0;
  for (let l = 175; l < 256; l++) peak = Math.max(peak, sm(l));
  let best = -1, bestCount = 0;
  for (let l = 255; l >= 175; l--) {
    const c = sm(l);
    const isMax = (l === 255 || c >= sm(l + 1)) && c >= sm(l - 1);
    if (isMax && c >= Math.max(total * 0.03, peak * 0.08)) {
      [best, bestCount] = [l, c];
      break;
    }
  }
  if (best < 0 || bestCount < total * 0.02) return [1, 1, 1];
  const chans: number[][] = [[], [], []];
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const o = (y * w + x) * 4;
      if (rgba[o + 3] < 128) continue;
      const l = 0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2];
      if (Math.abs(l - best) <= 4 && chans[0].length < 100_000) for (let c = 0; c < 3; c++) chans[c].push(rgba[o + c]);
    }
  return chans.map((a) => Math.max(0.6, Math.min(1, percentile(a, 50) / 255))) as Vec3;
}

/** tissue mask, one byte per pixel (1 = tissue). Transparent pixels (alpha < 128) are never tissue. */
export function tissueMask(rgba: ArrayLike<number>, w: number, h: number, beta = OD_BETA, i0?: number[]): Uint8Array {
  const bgI0 = i0 ?? estimateBackground(rgba, w, h, Math.max(1, Math.floor(Math.sqrt((w * h) / 250_000))));
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (rgba[o + 3] >= 128 && isTissue(rgba[o], rgba[o + 1], rgba[o + 2], beta, bgI0)) m[i] = 1;
  }
  return m;
}

/** tissue (and some background) pixels from an RGBA overview, subsampled to about `maxSamples` pixels */
export function sampleTissue(rgba: ArrayLike<number>, w: number, h: number, maxSamples = 250_000, beta = OD_BETA): TissueSample {
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / maxSamples)));
  const i0 = estimateBackground(rgba, w, h, step);
  const ln0 = i0.map(toOd);
  const cap = Math.ceil(w / step) * Math.ceil(h / step);
  const od = new Float32Array(cap * 3);
  const rgb = new Uint8Array(cap * 3);
  const bgCap = Math.min(cap, 50_000);
  const bg = new Uint8Array(bgCap * 3);
  let n = 0, nBg = 0, total = 0, bgSeen = 0;
  let seed = 0x9e3779b9;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const o = (y * w + x) * 4;
      if (rgba[o + 3] < 128) continue;
      total++;
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      const a0 = toOd(r / 255), a1 = toOd(g / 255), a2 = toOd(b / 255);
      const o0 = Math.max(0, a0 - ln0[0]), o1 = Math.max(0, a1 - ln0[1]), o2 = Math.max(0, a2 - ln0[2]);
      const mx = Math.max(o0, o1, o2);
      if (mx >= beta && Math.min(a0, a1, a2) < OD_BLACK) {
        od[n * 3] = o0; od[n * 3 + 1] = o1; od[n * 3 + 2] = o2;
        rgb[n * 3] = r; rgb[n * 3 + 1] = g; rgb[n * 3 + 2] = b;
        n++;
      } else if (mx < beta) {
        // reservoir-ish: keep every k-th background pixel so the buffer spans the whole slide
        bgSeen++;
        if (nBg < bgCap) {
          bg[nBg * 3] = r; bg[nBg * 3 + 1] = g; bg[nBg * 3 + 2] = b;
          nBg++;
        } else {
          const j = Math.floor(rand() * bgSeen);
          if (j < bgCap) { bg[j * 3] = r; bg[j * 3 + 1] = g; bg[j * 3 + 2] = b; }
        }
      }
    }
  return { od: od.subarray(0, n * 3), rgb: rgb.subarray(0, n * 3), n, bg: bg.subarray(0, nBg * 3), nBg, total, i0 };
}

// ---------------------------------------------------------------- statistics helpers

/** p-th percentile (0..100) of a numeric array (copied, sorted) */
export function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (!n) return NaN;
  const a = Float64Array.from(values as ArrayLike<number>).sort();
  const pos = Math.max(0, Math.min(n - 1, (p / 100) * (n - 1)));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/** eigen-decomposition of a symmetric 3×3 matrix (Jacobi). Returns eigenvalues descending, eigenvectors as rows. */
export function eigenSym3(m: number[]): { values: number[]; vectors: Vec3[] } {
  const a = m.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-14) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-18) continue;
      const app = a[p * 3 + p], aqq = a[q * 3 + q];
      const theta = (aqq - app) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p], akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k], aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  const idx = [0, 1, 2].sort((i, j) => a[j * 4] - a[i * 4]);
  return {
    values: idx.map((i) => a[i * 4]),
    vectors: idx.map((i) => [v[i], v[3 + i], v[6 + i]] as Vec3),
  };
}

// ---------------------------------------------------------------- Macenko

export interface MacenkoResult {
  /** two unit OD vectors, the one with the larger red OD (haematoxylin) first */
  vectors: number[][];
  /** 99th-percentile concentration of each stain */
  maxC: number[];
}

/**
 * Macenko et al. 2009: project the OD of stained pixels (all channels ≥ β) onto the plane of the two largest
 * eigenvectors of their covariance, take the extreme angles (alpha / 100 − alpha percentiles) as the stain vectors.
 */
export function macenko(s: TissueSample, alpha = 1, beta = OD_BETA): MacenkoResult | null {
  const idx: number[] = [];
  for (let i = 0; i < s.n; i++) if (s.od[i * 3] >= beta && s.od[i * 3 + 1] >= beta && s.od[i * 3 + 2] >= beta) idx.push(i);
  // pale stains (e.g. eosin has little red OD): fall back to every tissue pixel
  const use = idx.length >= 200 ? idx : Array.from({ length: s.n }, (_, i) => i);
  if (use.length < 50) return null;
  const mean = [0, 0, 0];
  for (const i of use) for (let c = 0; c < 3; c++) mean[c] += s.od[i * 3 + c];
  for (let c = 0; c < 3; c++) mean[c] /= use.length;
  const cov = new Array(9).fill(0);
  for (const i of use) {
    const d = [s.od[i * 3] - mean[0], s.od[i * 3 + 1] - mean[1], s.od[i * 3 + 2] - mean[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a * 3 + b] += d[a] * d[b];
  }
  for (let k = 0; k < 9; k++) cov[k] /= use.length - 1;
  const { vectors } = eigenSym3(cov);
  const e1 = vectors[0][0] < 0 ? (vectors[0].map((x) => -x) as Vec3) : vectors[0];
  const e2 = vectors[1][0] < 0 ? (vectors[1].map((x) => -x) as Vec3) : vectors[1];
  const phi = new Float64Array(use.length);
  use.forEach((i, k) => {
    const o = [s.od[i * 3], s.od[i * 3 + 1], s.od[i * 3 + 2]];
    phi[k] = Math.atan2(dot(o, e2), dot(o, e1));
  });
  const lo = percentile(phi, alpha);
  const hi = percentile(phi, 100 - alpha);
  const fromAngle = (t: number) => clampPositive([e1[0] * Math.cos(t) + e2[0] * Math.sin(t), e1[1] * Math.cos(t) + e2[1] * Math.sin(t), e1[2] * Math.cos(t) + e2[2] * Math.sin(t)]);
  let v1 = fromAngle(lo), v2 = fromAngle(hi);
  if (v1[0] < v2[0]) [v1, v2] = [v2, v1];
  if (angleDeg(v1, v2) < 2) return null;
  const maxC = stainMaxC(s, [v1, v2]);
  if (!maxC) return null;
  return { vectors: [v1, v2], maxC };
}

/** OD stain vectors are non-negative; tiny negatives come from noise */
function clampPositive(v: number[]): Vec3 {
  return unit([Math.max(v[0], 1e-4), Math.max(v[1], 1e-4), Math.max(v[2], 1e-4)]);
}

/** 99th percentile of each stain's concentration over the tissue pixels */
export function stainMaxC(s: TissueSample, vectors: number[][]): number[] | null {
  const b = stainBasis(vectors);
  const bi = b && inv3(b);
  if (!bi) return null;
  const c0 = new Float32Array(s.n), c1 = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) {
    const c = mulVec(bi, [s.od[i * 3], s.od[i * 3 + 1], s.od[i * 3 + 2]]);
    c0[i] = c[0];
    c1[i] = c[1];
  }
  return [Math.max(1e-3, percentile(c0, 99)), Math.max(1e-3, percentile(c1, 99))];
}

// ---------------------------------------------------------------- stain-type detection

/** hue (deg 0..360), saturation and value (0..1) of RGB 0..255 */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
  let h = 0;
  if (d > 1e-9) {
    if (mx === R) h = 60 * (((G - B) / d) % 6);
    else if (mx === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, mx > 0 ? d / mx : 0, mx];
}

export interface HueStats {
  /** fractions of tissue pixels */
  pink: number;
  /** strongly saturated magenta (PAS / Schiff; also dense eosin) */
  magenta: number;
  brown: number;
  /** violet-blue (haematoxylin, toluidine) */
  blue: number;
  /** cyan-blue (aniline blue of trichromes, alcian blue) */
  cyan: number;
  /** green (light green, fast green) */
  green: number;
  /** dark, unsaturated (silver, black) */
  dark: number;
  /** grey (little colour) */
  grey: number;
  meanSat: number;
}

export function hueStats(s: TissueSample): HueStats {
  const st: HueStats = { pink: 0, magenta: 0, brown: 0, blue: 0, cyan: 0, green: 0, dark: 0, grey: 0, meanSat: 0 };
  if (!s.n) return st;
  for (let i = 0; i < s.n; i++) {
    const [h, sat, v] = rgbToHsv(s.rgb[i * 3], s.rgb[i * 3 + 1], s.rgb[i * 3 + 2]);
    st.meanSat += sat;
    if (v < 0.3 && sat < 0.35) {
      st.dark++;
      continue;
    }
    if (sat < 0.1) {
      st.grey++;
      continue;
    }
    if (h >= 285 || h < 12) {
      st.pink++;
      if (sat > 0.45 && h >= 290 && h < 335) st.magenta++;
    } else if (h < 55) st.brown++;
    else if (h < 170) st.green++;
    else if (h < 228) st.cyan++;
    else st.blue++;
  }
  const n = s.n;
  for (const k of Object.keys(st) as (keyof HueStats)[]) st[k] /= n;
  return st;
}

export interface Detection {
  stainType: StainType;
  confidence: number;
  subtype: string | null;
  scores: Record<string, number>;
}

const closeness = (deg: number, tol: number) => Math.max(0, 1 - deg / tol);
const ramp = (x: number, lo: number, hi: number) => Math.max(0, Math.min(1, (x - lo) / (hi - lo)));

/**
 * Heuristic stain-type detection (calibrated on synthetic stains and real NDPI course slides: H&E incl. very
 * eosinophilic ones, H-DAB, and a single blue dye). Scores (≥ 0) are evidence sums; confidence =
 * top / (sum + 0.25), so weak or ambiguous evidence gives a low confidence.
 * - H&E: pink/magenta tissue, the estimated 2nd vector close to eosin, some violet nuclei.
 * - H-DAB: brown tissue, 2nd vector close to DAB.
 * - special: trichrome (green, or cyan-blue next to red), silver (dark unsaturated fibres), PAS (overwhelmingly
 *   saturated magenta: dense eosin is also magenta, so this needs ≥ 65 %), a single blue dye (toluidine etc.).
 */
export function detectStainType(s: TissueSample, est: MacenkoResult | null, tissueFraction: number): Detection {
  const hs = hueStats(s);
  if (s.n < 100 || tissueFraction < 0.002) return { stainType: "unknown", confidence: 0, subtype: null, scores: {} };
  const v2 = est?.vectors[1];
  const v1 = est?.vectors[0];
  const angE = v2 ? angleDeg(v2, REF_VECTORS.he[1]) : 90;
  const angD = v2 ? angleDeg(v2, REF_VECTORS.hdab[1]) : 90;
  const angH = v1 ? angleDeg(v1, REF_VECTORS.he[0]) : 90;
  const hOk = closeness(angH, 30);

  // PAS: on real course slides strongly eosinophilic H&E (muscle, bone, liver) is just as magenta as PAS, so magenta
  // alone only lowers the H&E confidence; PAS wins only when the tissue is almost entirely saturated magenta
  const pas = 2.4 * ramp(hs.magenta, 0.6, 0.92) * (hs.meanSat > 0.45 ? 1 : 0.6);
  const he =
    1.6 * Math.min(1, hs.pink / 0.45) + 0.6 * closeness(angE, 25) * (0.5 + 0.5 * hOk) + 0.3 * Math.min(1, hs.blue / 0.2) -
    1.2 * hs.brown - 1.5 * hs.green - 1.5 * hs.cyan - 0.4 * pas;
  const hdab = 2.2 * Math.min(1, hs.brown / 0.25) + 0.8 * closeness(angD, 20) * Math.min(1, hs.brown / 0.05) - 1.5 * hs.pink - 3 * hs.dark;
  const trichrome = 2.5 * Math.min(1, hs.green / 0.2) + 2.2 * Math.min(1, hs.cyan / 0.2) * Math.min(1, (hs.pink + hs.brown) / 0.1);
  const silver = 2.5 * ramp(hs.dark, 0.05, 0.25) * (0.7 + 0.3 * Math.min(1, hs.grey / 0.3));
  const blueDye = 2.0 * ramp(hs.blue + hs.cyan, 0.4, 0.7) * (1 - ramp(hs.pink + hs.brown, 0.05, 0.2));

  const special = Math.max(trichrome, silver, pas, blueDye);
  const subtype = special === silver ? "silver" : special === trichrome ? "trichrome" : special === pas ? "PAS" : "blue dye";
  const scores: Record<string, number> = {
    he: Math.max(0, he),
    hdab: Math.max(0, hdab),
    special: Math.max(0, special),
    trichrome: Math.max(0, trichrome),
    silver: Math.max(0, silver),
    pas: Math.max(0, pas),
    blueDye: Math.max(0, blueDye),
  };
  const main: [StainType, number][] = [
    ["he", scores.he],
    ["hdab", scores.hdab],
    ["special", scores.special],
  ];
  main.sort((a, b) => b[1] - a[1]);
  const sum = main.reduce((t, [, v]) => t + v, 0);
  const [type, top] = main[0];
  if (top < 0.35) return { stainType: "unknown", confidence: Math.min(0.5, top), subtype: null, scores };
  const confidence = Math.max(0, Math.min(0.99, top / (sum + 0.25)));
  return { stainType: type, confidence, subtype: type === "special" ? subtype : null, scores };
}

// ---------------------------------------------------------------- auto levels / gamma

export interface AutoLevels {
  black: [number, number, number];
  white: [number, number, number];
  gamma: number;
}

/** target brightness for the median tissue pixel after levels (bright, as students expect a pale background) */
export const GAMMA_TARGET = 0.62;

/**
 * Levels from the tissue histogram: black = 0.5th percentile of tissue (shared by all channels so hues are kept),
 * white = the background's median per channel when there is enough background (white balance), else the tissue's
 * 99.5th percentile. Gamma brings the median tissue luminance (after levels) halfway (in log space) to GAMMA_TARGET.
 */
export function autoLevels(s: TissueSample): AutoLevels | null {
  if (s.n < 50) return null;
  const ch = (buf: Uint8Array, n: number, c: number) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = buf[i * 3 + c] / 255;
    return a;
  };
  const t = [0, 1, 2].map((c) => ch(s.rgb, s.n, c));
  const blackAll = Math.min(...t.map((a) => percentile(a, 0.5)));
  const black = Math.max(0, Math.min(0.5, blackAll));
  const useBg = s.nBg >= Math.max(50, s.total * 0.03);
  const white = [0, 1, 2].map((c) => {
    const w = useBg ? percentile(ch(s.bg, s.nBg, c), 50) : percentile(t[c], 99.5);
    return Math.max(black + 0.25, Math.min(1, w));
  }) as [number, number, number];
  // tissue median luminance after levels
  const lum = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) {
    let l = 0;
    for (let c = 0; c < 3; c++) l += [0.2126, 0.7152, 0.0722][c] * Math.min(1, Math.max(0, (t[c][i] - black) / (white[c] - black)));
    lum[i] = l;
  }
  const m = Math.min(0.98, Math.max(0.02, percentile(lum, 50)));
  // out = in^(1/gamma): gamma = ln m / ln target maps m → target; take the geometric half-way
  const full = Math.log(m) / Math.log(GAMMA_TARGET);
  const gamma = Math.max(0.7, Math.min(1.6, Math.sqrt(full)));
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { black: [r3(black), r3(black), r3(black)], white: white.map(r3) as [number, number, number], gamma: Math.round(gamma * 100) / 100 };
}

// ---------------------------------------------------------------- everything at once

/** order estimated vectors like the reference of the detected type (haematoxylin first; it has the larger red OD) */
function orderVectors(v: number[][]): number[][] {
  return v[0][0] >= v[1][0] ? v : [v[1], v[0]];
}

/** the whole analysis of an RGBA overview */
export function analyseRgba(rgba: ArrayLike<number>, w: number, h: number): StainAnalysis {
  const s = sampleTissue(rgba, w, h);
  const tissueFraction = s.total ? s.n / s.total : 0;
  const est = macenko(s);
  const det = detectStainType(s, est, tissueFraction);
  const lv = autoLevels(s);
  return {
    width: w,
    height: h,
    tissueFraction,
    stainType: det.stainType,
    confidence: det.confidence,
    subtype: det.subtype,
    scores: det.scores,
    vectors: est ? orderVectors(est.vectors).map((r) => r.map((x) => Math.round(x * 10000) / 10000)) : null,
    maxC: est ? est.maxC : null,
    levels: lv ? { black: lv.black, white: lv.white } : null,
    gamma: lv ? lv.gamma : 1,
    background: s.i0.map((x) => Math.round(x * 1000) / 1000) as [number, number, number],
  };
}

/** human label: "H&E", "H-DAB", "Special (PAS)", "Unknown" */
export function stainLabel(t: StainType | null, subtype?: string | null): string {
  switch (t) {
    case "he":
      return "H&E";
    case "hdab":
      return "H-DAB (IHC)";
    case "special":
      return subtype ? `Special stain (${subtype})` : "Special stain";
    case "unknown":
      return "Unknown";
    default:
      return "—";
  }
}
