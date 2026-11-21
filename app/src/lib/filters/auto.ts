/**
 * One-click "Auto" actions (Adjust panel and settings.filters.autoOnOpen). They analyse a ≤ 2048 px RGBA
 * overview of the open slide (slideOverview) once per slide and cache the result in `filters.analysis`.
 * Owner: filters.
 */
import { useStore } from "../store";
import { fitSize, slideOverview } from "../backend";
import { planeKey, type StainAnalysis } from "../types";
import { analyseRgba, stainLabel } from "./stain";
import { modeForAnalysis, presetForAnalysis } from "./presets";

export const OVERVIEW_PX = 2048;

let inflight: { path: string; z: number; p: Promise<StainAnalysis> } | null = null;

const toast = (text: string, kind: "info" | "error" = "info") => useStore.getState().setUi({ toast: { text, kind } });

/** the open slide's analysis (cached unless `force`); updates filters.auto while it runs */
export async function ensureAnalysis(force = false): Promise<StainAnalysis> {
  const st = useStore.getState();
  const info = st.slide.info;
  const path = st.slide.path;
  if (!info || !path) throw new Error("No slide is open");
  if (st.filters.analysis && !force) return st.filters.analysis;
  const z = planeKey(st.view.z, st.view.t);
  if (inflight && inflight.path === path && inflight.z === z && !force) return inflight.p;
  const setAuto = (patch: Partial<typeof st.filters.auto>) => {
    const s = useStore.getState();
    if (s.slide.path === path) s.setFilters({ auto: { ...s.filters.auto, ...patch } });
  };
  setAuto({ status: "running", error: null });
  const p = (async () => {
    const { width, height } = fitSize(info.width, info.height, OVERVIEW_PX);
    const bytes = await slideOverview(info.id, OVERVIEW_PX, z, "rgba");
    if (bytes.length < width * height * 4) throw new Error(`overview has ${bytes.length} bytes, expected ${width * height * 4}`);
    // yield once so the "running" state paints before the (≈100 ms) analysis
    await new Promise((r) => setTimeout(r, 0));
    return analyseRgba(bytes, width, height);
  })();
  inflight = { path, z, p };
  try {
    const a = await p;
    const s = useStore.getState();
    if (s.slide.path !== path) throw new Error("The slide changed while it was being analysed");
    s.setFilters({ analysis: a, auto: { status: "done", error: null, stainType: a.stainType, confidence: a.confidence, vectors: a.vectors } });
    return a;
  } catch (e) {
    setAuto({ status: "error", error: String(e instanceof Error ? e.message : e) });
    throw e;
  } finally {
    if (inflight?.p === p) inflight = null;
  }
}

async function guarded<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/slide changed/.test(msg)) toast(`${what} failed: ${msg}`, "error");
    return undefined;
  }
}

/** levels + gamma from the tissue histogram */
export const autoLevels = () =>
  guarded("Auto levels", async () => {
    const a = await ensureAnalysis();
    if (!a.levels) throw new Error("not enough tissue found");
    useStore.getState().setFilterParams({ levels: a.levels, gamma: a.gamma });
  });

/** detect the stain type and apply its preset */
export const detectStain = (silent = false) =>
  guarded("Stain detection", async () => {
    const a = await ensureAnalysis();
    const patch = presetForAnalysis(a);
    useStore.getState().setFilterParams(patch);
    if (!silent) toast(`Detected ${stainLabel(a.stainType, a.subtype)} (${Math.round(a.confidence * 100)}%)`);
  });

/** Macenko vectors for stain separation (switches separation on with the detected mode if it was off) */
export const estimateVectors = () =>
  guarded("Vector estimation", async () => {
    const a = await ensureAnalysis();
    if (!a.vectors) throw new Error("not enough stained tissue to estimate vectors");
    const st = useStore.getState().filters.params.stain;
    const mode = modeForAnalysis(a);
    useStore.getState().setFilterParams({ stain: { mode, channel: st.mode === mode ? st.channel : -1, vectors: a.vectors.map((r) => r.slice()) } });
  });

/** colour-normalise to the reference H&E (toggles) */
export const normalise = (on?: boolean) =>
  guarded("Normalisation", async () => {
    const want = on ?? !useStore.getState().filters.params.normalize;
    if (!want) {
      useStore.getState().setFilterParams({ normalize: false });
      return;
    }
    const a = await ensureAnalysis();
    if (!a.vectors || !a.maxC) throw new Error("not enough stained tissue to normalise");
    useStore.getState().setFilterParams({ normalize: true });
  });

/** settings.filters.autoOnOpen: run the chosen steps (one analysis) */
export async function runAutoOnOpen(steps: { levels: boolean; stain: boolean; normalize: boolean }) {
  if (!steps.levels && !steps.stain && !steps.normalize) return;
  try {
    await ensureAnalysis();
  } catch {
    return; // the panel shows filters.auto.error
  }
  if (steps.stain) await detectStain(true);
  if (steps.levels) await autoLevels();
  if (steps.normalize) {
    const a = useStore.getState().filters.analysis;
    if (a?.stainType === "he") await normalise(true); // only H&E slides are normalised automatically
  }
}
