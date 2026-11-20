/**
 * Shared types: the CONTRACT between the backend, the store and the feature builders (CONTRACTS.md).
 * SHARED FILE: builders may APPEND new types in a clearly delimited section at the end; don't rename
 * or remove fields others use.
 */

// ---------------------------------------------------------------- slides (mirrors src-tauri/src/source/mod.rs)

export interface LevelInfo {
  width: number;
  height: number;
  downsample: number;
}

export interface ZPlane {
  /** what the tile URL's z carries */
  index: number;
  /** distance from nominal focus, nm (null when unknown) */
  offsetNm: number | null;
  label: string;
}

/** `open_slide` result. Coordinates: level-0 image pixels; nm via lib/coords.ts. */
export interface SlideInfo {
  /** registry id; tile URLs use it */
  id: number;
  path: string;
  /** Deep-Zoom tile size (256) and level of full resolution (ceil(log2(max(w, h)))) */
  tileSize: number;
  maxLevel: number;
  /** backend: "openslide" | "plain" | "czi" */
  format: string;
  vendor: string | null;
  width: number;
  height: number;
  /** µm per pixel; 1 when uncalibrated */
  mppX: number;
  mppY: number;
  /** false: the file has no pixel size; the ruler shows px and the UI says "uncalibrated" */
  calibrated: boolean;
  /** Hamamatsu offsets of the image centre from the slide centre (nm); 0 elsewhere */
  xOffsetNm: number;
  yOffsetNm: number;
  levels: LevelInfo[];
  /** always at least one plane (index 0) */
  zPlanes: ZPlane[];
  /** associated image names ("thumbnail", "macro", "label") */
  associated: string[];
}

// ---------------------------------------------------------------- folder browser (mirrors src-tauri/src/scan.rs)

export interface ScanEntry {
  path: string;
  name: string;
  /** folder relative to the root, "/"-separated; "" = the root itself */
  dir: string;
  /** lower-case, with the dot: ".ndpi" */
  ext: string;
  size: number;
  modifiedMs: number;
  /** existing annotation file for it, if any (badge in the browser) */
  annotationPath: string | null;
}

export interface ScanResult {
  root: string;
  entries: ScanEntry[];
  errors: string[];
}

export interface ScanProgress {
  root: string;
  folders: number;
  found: number;
}

export interface AnnotationPaths {
  primary: string;
  primaryExists: boolean;
  primaryWritable: boolean;
  fallback: string;
  fallbackExists: boolean;
}

// ---------------------------------------------------------------- annotations

/** Slide coordinates in nanometres (NDP.view convention: from the slide centre). */
export interface PtNm {
  x: number;
  y: number;
}

export type AnnotationKind = "pin" | "ruler" | "freehand" | "circle" | "rectangle" | "other";

/**
 * One annotation as the app works with it. All geometry in nm (NDP.view coordinates).
 * - pin: points = [p]
 * - ruler: points = [a, b]
 * - circle: points = [centre], radiusNm
 * - rectangle: 4 points, closed
 * - freehand: n points, closed or open
 * - other: an NDP.view annotation we don't edit (arrow, text, …): drawn if possible, always preserved
 */
export interface Annotation {
  /** app-local id (stable while the slide is open) */
  id: string;
  /** the ndpviewstate id attribute it came from / will be written with */
  ndpaId: number | null;
  kind: AnnotationKind;
  title: string;
  details: string;
  /** "#rrggbb" */
  color: string;
  points: PtNm[];
  radiusNm?: number;
  closed?: boolean;
  /** NDP.view's raw `type` / `displayname` attributes (kept for round-tripping) */
  ndpType?: string;
  displayName?: string;
  /** opaque handle owned by lib/ndpa.ts (e.g. the original XML node) so unknown XML survives */
  source?: unknown;
}

/** Toolbar tools (SPEC: Pan V, Pin P, Ruler R, Freehand F, Circle C, Rectangle B). */
export type Tool = "pan" | "pin" | "ruler" | "freehand" | "circle" | "rectangle";
export const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: "pan", label: "Pan", key: "v" },
  { id: "pin", label: "Pin", key: "p" },
  { id: "ruler", label: "Ruler", key: "r" },
  { id: "freehand", label: "Freehand", key: "f" },
  { id: "circle", label: "Circle", key: "c" },
  { id: "rectangle", label: "Rectangle", key: "b" },
];

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

// ---------------------------------------------------------------- filters

export type StainMode = "none" | "he" | "hdab";
export type StainType = "he" | "hdab" | "special" | "unknown";

/** Image adjustments. Neutral values (DEFAULT_FILTERS) must be a no-op. */
export interface FilterParams {
  /** 1 = none; >1 brightens mid-tones */
  gamma: number;
  /** -1..1, 0 = none */
  brightness: number;
  /** -1..1, 0 = none */
  contrast: number;
  /** -1..1, 0 = none (-1 = grey) */
  saturation: number;
  /** degrees, -180..180 */
  hue: number;
  grayscale: boolean;
  invert: boolean;
  /** unsharp mask amount 0..2 and radius in screen px */
  sharpen: number;
  sharpenRadius: number;
  /** auto levels: per-channel black/white points 0..1 (null = off) */
  levels: { black: [number, number, number]; white: [number, number, number] } | null;
  /** stain separation: show one stain channel */
  stain: { mode: StainMode; channel: number; vectors: number[][] | null };
  /** colour normalisation to the reference H&E */
  normalize: boolean;
}

export const DEFAULT_FILTERS: FilterParams = {
  gamma: 1,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  grayscale: false,
  invert: false,
  sharpen: 0,
  sharpenRadius: 1,
  levels: null,
  stain: { mode: "none", channel: 0, vectors: null },
  normalize: false,
};

/** Results of the one-click "Auto" analyses for the open slide. */
export interface AutoState {
  status: "idle" | "running" | "done" | "error";
  error: string | null;
  /** detected stain type and confidence 0..1 */
  stainType: StainType | null;
  confidence: number;
  /** Macenko stain vectors (rows: stains, cols: RGB OD) */
  vectors: number[][] | null;
}

// ---------------------------------------------------------------- feature additions (append below, one delimited block per builder)
