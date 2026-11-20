// Tests for the filters feature (lib/filters/**). Owner: filters builder (CONTRACTS.md).
import { test, ok, eq, near } from "./harness";
import { DEFAULT_FILTERS, type FilterParams, type StainAnalysis } from "../src/lib/types";
import {
  IDENTITY, NORM_REF, REF_VECTORS, normScales, angleDeg, applyPixel, applyToRgba, fromOd, inv3, isNeutral, mul3, mulVec,
  stainBasis, stainMatrix, toOd, uniformsFor, validVectors,
} from "../src/lib/filters/math";
import {
  analyseRgba, autoLevels, detectStainType, eigenSym3, estimateBackground, hueStats, isTissue, macenko, percentile, rgbToHsv, sampleTissue, stainLabel, tissueMask,
} from "../src/lib/filters/stain";
import { PRESETS, applyPreset, presetForAnalysis } from "../src/lib/filters/presets";
import { useStore } from "../src/lib/store";
import { installFilterState, applyFiltersToImageData } from "../src/lib/filters/pipeline";

const P = (p: Partial<FilterParams>): FilterParams => ({ ...DEFAULT_FILTERS, ...p });

// ---------------------------------------------------------------- synthetic slides

/** deterministic PRNG */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** RGB 0..255 of stain concentrations c (per stain) mixed with unit OD vectors (Beer–Lambert) */
function mix(vectors: number[][], c: number[], i0 = 255): [number, number, number] {
  const od = [0, 0, 0];
  vectors.forEach((v, i) => {
    for (let k = 0; k < 3; k++) od[k] += v[k] * c[i];
  });
  return od.map((d) => Math.round(Math.min(255, i0 * Math.exp(-d)))) as [number, number, number];
}

/**
 * A w×h RGBA "slide": background (≈ 240,240,238) with a tissue disc in the middle whose pixels are random
 * mixtures of the given stains (concentrations up to cmax), plus a transparent border column.
 */
function synthSlide(vectors: number[][], cmax: number[], w = 200, h = 160, seed = 7) {
  const r = rng(seed);
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (x === 0) continue; // transparent padding (alpha 0)
      const inside = (x - w / 2) ** 2 / (w * 0.35) ** 2 + (y - h / 2) ** 2 / (h * 0.35) ** 2 < 1;
      let rgb: [number, number, number];
      if (inside) {
        // each pixel is dominated by one stain, with some of the other (as in real tissue)
        const k = r() < 0.5 ? 0 : 1;
        const c = vectors.map((_, i) => (i === k ? 0.25 + r() * cmax[i] : r() * 0.15 * cmax[i]));
        rgb = mix(vectors, c, 241); // the scanner's glass (I0) is ~241, as on real slides
      } else rgb = [240 + Math.round(r() * 2), 240 + Math.round(r() * 2), 240 + Math.round(r() * 2)];
      px[o] = rgb[0];
      px[o + 1] = rgb[1];
      px[o + 2] = rgb[2];
      px[o + 3] = 255;
    }
  return { px, w, h };
}

/** a flat-colour slide region: background + patches of given RGB colours */
function patchSlide(colors: [number, number, number][], w = 120, h = 100) {
  const px = new Uint8ClampedArray(w * h * 4);
  const r = rng(3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const tissue = x > w * 0.15 && x < w * 0.85 && y > h * 0.15 && y < h * 0.85;
      const base = tissue ? colors[Math.floor(r() * colors.length)] : ([242, 241, 239] as [number, number, number]);
      for (let k = 0; k < 3; k++) px[o + k] = Math.max(0, Math.min(255, base[k] + Math.round((r() - 0.5) * 10)));
      px[o + 3] = 255;
    }
  return { px, w, h };
}

// ---------------------------------------------------------------- math

test("filters: OD round trip and stain basis inverse", () => {
  for (const v of [1, 0.5, 0.1, 1 / 255]) near(fromOd(toOd(v)), v, 1e-12, `OD round trip ${v}`);
  ok(Number.isFinite(toOd(0)), "OD of 0 is finite (clamped at 1/255)");
  const b = stainBasis(REF_VECTORS.he)!;
  const bi = inv3(b)!;
  const I = mul3(b, bi);
  ok(I.every((x, i) => Math.abs(x - IDENTITY[i]) < 1e-9), "basis · basis⁻¹ = I");
  // a pure-eosin OD deconvolves to (0, c, 0)
  const c = mulVec(bi, REF_VECTORS.he[1].map((x) => x * 0.8));
  near(c[0], 0, 1e-9, "pure eosin: no haematoxylin");
  near(c[1], 0.8 * Math.hypot(...REF_VECTORS.he[1]), 1e-9, "pure eosin: eosin concentration");
  near(c[2], 0, 1e-9, "pure eosin: no residual");
  ok(validVectors(REF_VECTORS.hdab), "reference H-DAB vectors are valid");
  ok(!validVectors([[1, 0, 0], [2, 0, 0]]), "parallel vectors are invalid");
  ok(!validVectors([[1, 0, 0]]), "one vector is invalid");
});

test("filters: neutral params are a no-op (CPU reference)", () => {
  const u = uniformsFor(DEFAULT_FILTERS);
  ok(isNeutral(u), "DEFAULT_FILTERS is neutral");
  const { px, w, h } = synthSlide(REF_VECTORS.he, [1.5, 1]);
  const out = applyToRgba(px, w, h, u);
  ok(out.every((x, i) => x === px[i]), "applyToRgba with neutral uniforms returns identical bytes");
  ok(!isNeutral(uniformsFor(P({ gamma: 1.2 }))), "gamma 1.2 is not neutral");
  ok(!isNeutral(uniformsFor(P({ levels: { black: [0.1, 0.1, 0.1], white: [1, 1, 1] } }))), "levels are not neutral");
  ok(isNeutral(uniformsFor(P({ levels: { black: [0, 0, 0], white: [1, 1, 1] } }))), "identity levels are neutral");
  ok(isNeutral(uniformsFor(P({ normalize: true }), null)), "normalise without an analysis is a no-op");
});

test("filters: point operations", () => {
  const px = (p: Partial<FilterParams>, c: number[]) => applyPixel(uniformsFor(P(p)), c.slice());
  near(px({ gamma: 2 }, [0.25, 0.25, 0.25])[0], 0.5, 1e-9, "gamma 2 maps 0.25 → 0.5 (brightens)");
  near(px({ gamma: 0.5 }, [0.5, 0.5, 0.5])[0], 0.25, 1e-9, "gamma 0.5 maps 0.5 → 0.25");
  near(px({ brightness: 0.2 }, [0.5, 0.5, 0.5])[0], 0.6, 1e-9, "brightness +20% adds 0.1");
  near(px({ contrast: 0.5 }, [0.75, 0.75, 0.75])[0], 1, 1e-9, "contrast +50% doubles the distance from mid-grey");
  near(px({ contrast: -0.5 }, [0.7, 0.7, 0.7])[0], 0.6, 1e-9, "contrast −50% halves it");
  eq(px({ invert: true }, [0.2, 0.4, 1]).map((x) => +x.toFixed(6)), [0.8, 0.6, 0], "invert");
  const g = px({ grayscale: true }, [1, 0, 0]);
  ok(g[0] === g[1] && g[1] === g[2], "greyscale gives equal channels");
  near(g[0], 0.2126, 1e-9, "greyscale uses Rec.709 luma");
  const s = px({ saturation: -1 }, [0.9, 0.2, 0.3]);
  ok(Math.abs(s[0] - s[1]) < 1e-9 && Math.abs(s[1] - s[2]) < 1e-9, "saturation −100% is grey");
  const grey = px({ hue: 120, saturation: 0.5 }, [0.4, 0.4, 0.4]);
  ok(grey.every((x) => Math.abs(x - 0.4) < 1e-6), "hue / saturation leave grey unchanged");
  const hue = px({ hue: 180 }, [0.8, 0.3, 0.3]);
  ok(hue[1] > hue[0] && hue[2] > hue[0], "hue 180° turns red cyan-ish");
  const lv = px({ levels: { black: [0.1, 0.1, 0.1], white: [0.9, 0.9, 0.9] } }, [0.5, 0.05, 0.95]);
  eq(lv.map((x) => +x.toFixed(6)), [0.5, 0, 1], "levels stretch and clip");
});

test("filters: unsharp mask leaves flat areas and sharpens edges", () => {
  const w = 16, h = 4;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = x < 8 ? 60 : 180;
      px.set([v, v, v, 255], (y * w + x) * 4);
    }
  const out = applyToRgba(px, w, h, uniformsFor(P({ sharpen: 1, sharpenRadius: 1 })), 1);
  eq([out[0], out[(2 * w + 2) * 4]], [60, 60], "flat dark area unchanged");
  ok(out[(1 * w + 7) * 4] < 60, "dark side of the edge gets darker");
  ok(out[(1 * w + 8) * 4] > 180, "bright side of the edge gets brighter");
  eq(out[3], 255, "alpha kept");
});

test("filters: stain separation shows one stain in its own colour", () => {
  const he = REF_VECTORS.he;
  const pure = (k: number, c: number) => mix(he, k === 0 ? [c, 0] : [0, c]).map((x) => x / 255);
  const both = mix(he, [1, 0.6]).map((x) => x / 255);
  const hOnly = applyPixel(uniformsFor(P({ stain: { mode: "he", channel: 0, vectors: null } })), both.slice());
  const want = pure(0, 1);
  ok(hOnly.every((x, i) => Math.abs(x - want[i]) < 0.01), `H channel of an H+E pixel = pure H (${hOnly.map((x) => x.toFixed(3))} vs ${want.map((x) => x.toFixed(3))})`);
  const eOnly = applyPixel(uniformsFor(P({ stain: { mode: "he", channel: 1, vectors: null } })), both.slice());
  const wantE = pure(1, 0.6);
  ok(eOnly.every((x, i) => Math.abs(x - wantE[i]) < 0.01), "E channel of an H+E pixel = pure E");
  const all = applyPixel(uniformsFor(P({ stain: { mode: "he", channel: -1, vectors: null } })), both.slice());
  ok(all.every((x, i) => Math.abs(x - both[i]) < 0.01), "recombining all stains reproduces a pure-stain mixture");
  const white = applyPixel(uniformsFor(P({ stain: { mode: "hdab", channel: 1, vectors: null } })), [1, 1, 1]);
  ok(white.every((x) => Math.abs(x - 1) < 1e-9), "background stays white in any channel");
  // custom vectors are used when valid
  const custom = [[0.6, 0.7, 0.3], [0.3, 0.6, 0.7]];
  const m1 = stainMatrix(P({ stain: { mode: "hdab", channel: 1, vectors: custom } }), null)!;
  const m2 = stainMatrix(P({ stain: { mode: "hdab", channel: 1, vectors: null } }), null)!;
  ok(m1.some((x, i) => Math.abs(x - m2[i]) > 1e-3), "custom vectors change the matrix");
  ok(stainMatrix(P({ stain: { mode: "hdab", channel: 1, vectors: [[1, 0, 0]] } }), null) != null, "invalid custom vectors fall back to the reference");
});

test("filters: normalisation maps the source stains onto the reference H&E", () => {
  const src = [[0.7, 0.65, 0.3], [0.15, 0.95, 0.25]].map((v) => {
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  });
  // source H:E balance equals the reference's -> scales are 1, colours swap to the reference vectors
  const maxC = [NORM_REF.maxC[0] * 0.6, NORM_REF.maxC[1] * 0.6];
  eq(normScales(maxC).map((x) => +x.toFixed(6)), [1, 1], "same balance -> unit scales");
  const sc = normScales([0.4, 0.9]);
  ok(sc[0] <= 2 && sc[1] >= 0.5 && sc[0] > 1 && sc[1] < 1, `weak haematoxylin is boosted, eosin damped, clamped (${sc})`);
  const a: StainAnalysis = {
    width: 1, height: 1, tissueFraction: 0.5, stainType: "he", confidence: 0.9, subtype: null, scores: {},
    vectors: src, maxC, levels: null, gamma: 1,
  };
  const u = uniformsFor(P({ normalize: true }), a);
  ok(u.stainOn, "normalise with an analysis turns the OD matrix on");
  const pix = mix(src, [1.2, 0]).map((x) => x / 255);
  const out = applyPixel(u, pix.slice());
  const unitRef = NORM_REF.vectors.map((v) => { const n = Math.hypot(...v); return v.map((x) => x / n); });
  const want = mix(unitRef, [1.2, 0]).map((x) => x / 255);
  ok(out.every((x, i) => Math.abs(x - want[i]) < 0.02), `pure source H -> pure reference H (${out.map((x) => x.toFixed(3))} vs ${want.map((x) => x.toFixed(3))})`);
});

// ---------------------------------------------------------------- stain analysis

test("filters: background (I0) estimation and background-relative OD", () => {
  // grey glass at 220 with tissue: 220 must not count as tissue
  const w = 100, h = 80;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const rgb = x < 30 ? [221, 219, 224] : mix(REF_VECTORS.he, [0.4 + (i % 7) * 0.1, 0.3]);
    px.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  }
  const bg = estimateBackground(px, w, h);
  near(bg[0], 221 / 255, 0.01, "background red");
  near(bg[2], 224 / 255, 0.01, "background blue");
  const s = sampleTissue(px, w, h);
  near(s.n / s.total, 0.7, 0.02, `grey glass is background, not tissue (${(s.n / s.total).toFixed(2)})`);
  ok(!isTissue(221, 219, 224, 0.15, bg), "glass colour is not tissue relative to its own I0");
  ok(isTissue(221, 219, 224), "…but would be against pure white");
  // pale tissue covering most of the overview: the brighter glass still wins
  const p2 = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) p2.set(i % w < 12 ? [236, 236, 238, 255] : [205, 196, 210, 255], i * 4);
  near(estimateBackground(p2, w, h)[0], 236 / 255, 0.01, "brightest substantial mode is the glass");
  // separation with an analysed background keeps the glass white
  const a: StainAnalysis = { width: 1, height: 1, tissueFraction: 0.5, stainType: "he", confidence: 0.9, subtype: null, scores: {}, vectors: null, maxC: null, levels: null, gamma: 1, background: [221 / 255, 219 / 255, 224 / 255] };
  const out = applyPixel(uniformsFor(P({ stain: { mode: "he", channel: 0, vectors: null } }), a), [221 / 255, 219 / 255, 224 / 255]);
  ok(out.every((x) => x > 0.999), "glass → white in a separated channel");
});

test("filters: tissue mask by OD threshold", () => {
  ok(!isTissue(245, 245, 245), "white background is not tissue");
  ok(isTissue(200, 120, 180), "pink/purple is tissue");
  ok(!isTissue(2, 2, 2), "pure black (pen, edge) is not tissue");
  ok(isTissue(240, 200, 230), "pale eosin is tissue");
  const { px, w, h } = synthSlide(REF_VECTORS.he, [1.5, 1]);
  const m = tissueMask(px, w, h);
  eq(m[0], 0, "transparent padding is not tissue");
  eq(m[(Math.floor(h / 2) * w + Math.floor(w / 2))], 1, "slide centre is tissue");
  const frac = m.reduce((s, x) => s + x, 0) / (w * h);
  ok(frac > 0.3 && frac < 0.45, `tissue fraction ≈ ellipse area (${frac.toFixed(3)})`);
});

test("filters: percentile and symmetric eigen-decomposition", () => {
  eq(percentile([5, 1, 3, 2, 4], 50), 3, "median");
  eq(percentile([0, 10], 25), 2.5, "interpolated percentile");
  const { values, vectors } = eigenSym3([4, 1, 0, 1, 3, 0, 0, 0, 1]);
  ok(values[0] >= values[1] && values[1] >= values[2], "eigenvalues descending");
  for (let i = 0; i < 3; i++) {
    const Av = mulVec([4, 1, 0, 1, 3, 0, 0, 0, 1], vectors[i]);
    ok(Av.every((x, k) => Math.abs(x - values[i] * vectors[i][k]) < 1e-9), `A v${i} = λ v${i}`);
  }
});

test("filters: Macenko recovers the stain vectors of a synthetic H&E slide", () => {
  const he = REF_VECTORS.he.map((v) => { const n = Math.hypot(...v); return v.map((x) => x / n); });
  const { px, w, h } = synthSlide(he, [1.6, 1.0]);
  const s = sampleTissue(px, w, h);
  const est = macenko(s)!;
  ok(!!est, "estimated");
  const aH = angleDeg(est.vectors[0], he[0]);
  const aE = angleDeg(est.vectors[1], he[1]);
  ok(aH < 8, `haematoxylin vector within 8° (${aH.toFixed(1)}°)`);
  ok(aE < 8, `eosin vector within 8° (${aE.toFixed(1)}°)`);
  ok(est.maxC[0] > 1 && est.maxC[0] < 2.2, `max H concentration plausible (${est.maxC[0].toFixed(2)})`);
});

test("filters: stain-type detection (H&E, H-DAB, special) with confidence", () => {
  const he = synthSlide(REF_VECTORS.he, [1.6, 1.0], 200, 160, 11);
  const a = analyseRgba(he.px, he.w, he.h);
  eq(a.stainType, "he", `synthetic H&E detected as H&E (${JSON.stringify(a.scores)})`);
  ok(a.confidence >= 0.5, `H&E confidence ≥ 50% (${a.confidence.toFixed(2)})`);
  ok(!!a.vectors && a.vectors[0][0] > a.vectors[1][0], "haematoxylin first");
  ok(a.tissueFraction > 0.3 && a.tissueFraction < 0.5, "tissue fraction");

  const dab = synthSlide(REF_VECTORS.hdab, [0.8, 1.4], 200, 160, 12);
  const b = analyseRgba(dab.px, dab.w, dab.h);
  eq(b.stainType, "hdab", `synthetic H-DAB detected as H-DAB (${JSON.stringify(b.scores)})`);
  ok(b.confidence >= 0.5, `H-DAB confidence ≥ 50% (${b.confidence.toFixed(2)})`);

  // Masson trichrome: red muscle, blue/green collagen, dark nuclei
  const tri = patchSlide([[200, 40, 60], [70, 150, 140], [80, 160, 150], [60, 110, 170], [90, 60, 110]]);
  const t = analyseRgba(tri.px, tri.w, tri.h);
  eq([t.stainType, t.subtype], ["special", "trichrome"], `trichrome-like colours → special (trichrome) (${JSON.stringify(t.scores)})`);

  // silver: black fibres and grey-brown background tissue
  const ag = patchSlide([[30, 28, 26], [40, 38, 35], [150, 140, 125], [25, 25, 25]]);
  const g = analyseRgba(ag.px, ag.w, ag.h);
  eq([g.stainType, g.subtype], ["special", "silver"], `silver-like colours → special (silver) (${JSON.stringify(g.scores)})`);

  // PAS: almost entirely saturated magenta → PAS; a mostly-magenta slide (dense eosin looks the same) is at least
  // less certain than a classic H&E
  const pas = patchSlide([[200, 40, 170], [190, 60, 180], [205, 45, 175], [210, 70, 190]]);
  const q = analyseRgba(pas.px, pas.w, pas.h);
  eq([q.stainType, q.subtype], ["special", "PAS"], `saturated magenta → special (PAS) (${JSON.stringify(q.scores)})`);
  const mostly = patchSlide([[200, 40, 170], [190, 60, 180], [205, 45, 175], [120, 110, 190]]);
  const q2 = analyseRgba(mostly.px, mostly.w, mostly.h);
  ok((q2.stainType === "special" && q2.subtype === "PAS") || (q2.stainType === "he" && q2.confidence < a.confidence), `mostly magenta → PAS, or H&E with lower confidence (${q2.stainType} ${q2.confidence.toFixed(2)})`);

  // a single blue dye (toluidine, Luxol): blue tissue, no pink
  const blue = patchSlide([[60, 70, 170], [80, 90, 190], [40, 50, 140]]);
  const bd = analyseRgba(blue.px, blue.w, blue.h);
  eq([bd.stainType, bd.subtype], ["special", "blue dye"], `blue-only tissue → special (blue dye) (${JSON.stringify(bd.scores)})`);

  // a blank slide has no tissue
  const blank = patchSlide([[242, 241, 239]]);
  const z = analyseRgba(blank.px, blank.w, blank.h);
  eq(z.stainType, "unknown", "blank slide → unknown");
  eq(z.vectors, null, "blank slide → no vectors");

  eq(stainLabel("he"), "H&E", "label H&E");
  eq(stainLabel("special", "PAS"), "Special stain (PAS)", "label special");
  const hs = hueStats(sampleTissue(he.px, he.w, he.h));
  ok(hs.pink + hs.blue > 0.5, "H&E tissue is mostly pink / blue-purple");
  void detectStainType;
});

test("filters: auto levels from the tissue histogram", () => {
  // a dull, low-contrast, slightly yellow H&E: background (230, 228, 210), tissue mid-tones
  const he = REF_VECTORS.he;
  const r = rng(5);
  const w = 160, h = 120;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const tissue = x > 40 && x < 120;
    const rgb = tissue ? mix(he, [0.3 + r() * 0.6, 0.2 + r() * 0.4]).map((v, k) => Math.round(v * [0.9, 0.89, 0.82][k])) : [230, 228, 210];
    px.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  }
  const lv = autoLevels(sampleTissue(px, w, h))!;
  ok(!!lv, "levels found");
  near(lv.white[2], 210 / 255, 0.01, "white point of blue = background blue (white balance)");
  near(lv.white[0], 230 / 255, 0.01, "white point of red = background red");
  ok(lv.black[0] > 0 && lv.black[0] === lv.black[1] && lv.black[1] === lv.black[2], "shared black point above 0");
  ok(lv.gamma >= 0.7 && lv.gamma <= 1.6, `gamma in range (${lv.gamma})`);
  // after levels the background is white
  const u = uniformsFor(P({ levels: { black: lv.black, white: lv.white } }));
  const bg = applyPixel(u, [230 / 255, 228 / 255, 210 / 255]);
  ok(bg.every((x) => x > 0.99), "background becomes white");
});

test("filters: presets", () => {
  ok(PRESETS.length >= 6, "several presets");
  const cur = P({ levels: { black: [0.1, 0.1, 0.1], white: [0.9, 0.9, 0.9] }, gamma: 2, normalize: true });
  const p = applyPreset(cur, PRESETS.find((x) => x.id === "nuclei")!);
  eq(p.stain.mode, "he", "nuclei preset → H&E separation");
  eq(p.gamma, 1, "preset replaces tone");
  eq(p.normalize, true, "preset keeps normalisation");
  ok(!!p.levels, "preset keeps auto levels");
  const base: StainAnalysis = { width: 1, height: 1, tissueFraction: 0.4, stainType: "hdab", confidence: 0.8, subtype: null, scores: {}, vectors: REF_VECTORS.hdab, maxC: [1, 1], levels: null, gamma: 1 };
  const d = presetForAnalysis(base);
  eq(d.stain?.mode, "none", "detection never switches separation on by itself");
  eq(d.stain?.vectors, REF_VECTORS.hdab, "detection primes the estimated vectors");
  eq(presetForAnalysis({ ...base, stainType: "unknown" }), {}, "unknown stain → no change");
});

test("filters: per-slide state in the store", () => {
  installFilterState();
  const st = useStore.getState;
  useStore.setState((s) => ({ slide: { ...s.slide, path: "/a.ndpi" } }));
  st().setFilterParams({ gamma: 1.5 });
  useStore.setState((s) => ({ slide: { ...s.slide, path: "/b.ndpi" } }));
  eq(st().filters.params.gamma, 1, "a new slide starts neutral");
  st().setFilterParams({ invert: true });
  useStore.setState((s) => ({ slide: { ...s.slide, path: "/a.ndpi" } }));
  eq([st().filters.params.gamma, st().filters.params.invert], [1.5, false], "slide A's filters come back");
  useStore.setState((s) => ({ slide: { ...s.slide, path: "/b.ndpi" } }));
  eq(st().filters.params.invert, true, "slide B's filters come back");
  useStore.setState((s) => ({ slide: { ...s.slide, path: null } }));
  eq(st().filters.params, DEFAULT_FILTERS, "no slide → neutral");
});

test("filters: applyFiltersToImageData uses the store and honours bypass", () => {
  const w = 4, h = 2;
  const data = new Uint8ClampedArray(w * h * 4).fill(128);
  const img = { data, width: w, height: h } as ImageData;
  const g = globalThis as { ImageData?: unknown };
  g.ImageData ??= class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  };
  const s = useStore.getState();
  s.setFilters({ params: P({ invert: true }), enabled: true });
  const out = applyFiltersToImageData(img, { pxScale: 1 });
  eq(out.data[0], 127, "inverted through the store");
  s.setFilters({ enabled: false });
  ok(applyFiltersToImageData(img) === img, "bypassed → same ImageData");
  ok(applyFiltersToImageData(img, { params: P({ invert: true }) }) !== img, "explicit params ignore the bypass");
  s.setFilters({ params: DEFAULT_FILTERS, enabled: true });
});
