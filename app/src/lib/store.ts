/**
 * The app store (zustand). SHARED FILE, CONTRACT (CONTRACTS.md): one typed slice per feature plus
 * small generic actions. Feature logic lives in the feature's own files and uses
 * `useStore.getState()` / the `setX` patchers; builders may APPEND fields to their own slice
 * interface + initial value, and should not change other slices.
 */
import { create } from "zustand";
import * as backend from "./backend";
import {
  DEFAULT_FILTERS,
  type Annotation,
  type AutoState,
  type FilterParams,
  type SaveState,
  type ScanProgress,
  type ScanResult,
  type SlideInfo,
  type Tool,
} from "./types";

// ---------------------------------------------------------------- browser (owner: browser)
export interface BrowserSlice {
  /** the parent folder being browsed */
  root: string | null;
  scan: ScanResult | null;
  scanning: boolean;
  progress: ScanProgress | null;
  error: string | null;
  /** name search */
  query: string;
  /** collapsed folders (ScanEntry.dir values) */
  collapsedDirs: string[];
}
const initialBrowser: BrowserSlice = { root: null, scan: null, scanning: false, progress: null, error: null, query: "", collapsedDirs: [] };

// ---------------------------------------------------------------- slide (owner: foundation; read by all)
export interface SlideSlice {
  path: string | null;
  info: SlideInfo | null;
  loading: boolean;
  error: string | null;
  /** increments on every successful open (effects can key on it) */
  openNonce: number;
}
const initialSlide: SlideSlice = { path: null, info: null, loading: false, error: null, openNonce: 0 };

// ---------------------------------------------------------------- annotations (owner: annotations)
export interface AnnotationsSlice {
  items: Annotation[];
  /** selected annotation ids */
  selection: string[];
  /** active toolbar tool */
  tool: Tool;
  /** previous `items` arrays (most recent last) */
  undo: Annotation[][];
  redo: Annotation[][];
  /** opaque parsed document owned by lib/ndpa.ts (keeps unknown XML for round-tripping) */
  doc: unknown;
  /** where the annotations were loaded from / are saved to */
  filePath: string | null;
  save: SaveState;
  saveError: string | null;
  /** annotation whose title is being edited inline (double-click renames) */
  editingId: string | null;
}
const initialAnnotations: AnnotationsSlice = {
  items: [],
  selection: [],
  tool: "pan",
  undo: [],
  redo: [],
  doc: null,
  filePath: null,
  save: "idle",
  saveError: null,
  editingId: null,
};
const MAX_UNDO = 200;

// ---------------------------------------------------------------- filters (owner: filters)
export interface FiltersSlice {
  params: FilterParams;
  /** false = show the unfiltered image (compare / bypass) */
  enabled: boolean;
  auto: AutoState;
  // ==== filters: per-slide state ====
  /** stain / levels analysis of the open slide (null until an Auto action runs) */
  analysis: StainAnalysis | null;
  /** filter state of slides opened earlier this session, by slide path (restored when one is reopened) */
  bySlide: Record<string, { params: FilterParams; auto: AutoState; analysis: StainAnalysis | null }>;
  // ==== end filters ====
}
// ==== filters ====
import type { StainAnalysis } from "./types";
// ==== end filters ====
const initialAuto: AutoState = { status: "idle", error: null, stainType: null, confidence: 0, vectors: null };
const initialFilters: FiltersSlice = { params: DEFAULT_FILTERS, enabled: true, auto: initialAuto, analysis: null, bySlide: {} };

// ---------------------------------------------------------------- view (owner: viewer)
export interface ViewSlice {
  /** view rotation in degrees (clockwise; the viewer applies it, coordinates never change) */
  rotation: number;
  /** focal plane: a ZPlane.index of the open slide */
  z: number;
  /** time point: a TimePoint.index of the open slide (0 when it has no time series) */
  t: number;
  /** the time series is playing (TimeBar steps `t`) */
  playing: boolean;
  /** written by the viewer on every viewport change: OSD viewport zoom and µm per screen px */
  zoom: number;
  umPerScreenPx: number | null;
  /** objective-style magnification of the current view (e.g. 10 = "10×"), written by the viewer */
  magnification: number | null;
  /** bump to fit the whole slide */
  homeNonce: number;
  /** 3D perspective tilt of the whole slide plane, degrees (Adjust ▸ Rotate ▸ Perspective). View only:
   *  while either is non-zero, annotations can't be placed or edited (pointer positions don't map) */
  tiltX: number;
  tiltY: number;
}
/** the slide is tipped in 3D (see ViewSlice.tiltX / tiltY) */
export const isTilted = (v: Pick<ViewSlice, "tiltX" | "tiltY">) => Math.abs(v.tiltX) > 0.05 || Math.abs(v.tiltY) > 0.05;
const initialView: ViewSlice = { rotation: 0, z: 0, t: 0, playing: false, zoom: 1, umPerScreenPx: null, magnification: null, homeNonce: 0, tiltX: 0, tiltY: 0 };

// ---------------------------------------------------------------- ui (shared)
export type PanelTab = "annotations" | "adjust";
export interface MenuItemSpec {
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** shows a check mark in the icon column */
  checked?: boolean;
  /** a colour dot in the icon column */
  swatch?: string;
  /** opens a second menu beside this item on hover (or →); onSelect is then optional */
  submenu?: (MenuItemSpec | "sep")[];
  onSelect?: () => void;
}
export interface ContextMenuState {
  x: number;
  y: number;
  items: (MenuItemSpec | "sep")[];
}
export interface UiSlice {
  sidebarOpen: boolean;
  panelOpen: boolean;
  panelTab: PanelTab;
  /** help article shown in the in-page fallback panel (outside Tauri), null = closed */
  help: string | null;
  settingsOpen: boolean;
  menu: ContextMenuState | null;
  toast: { text: string; kind: "info" | "error" } | null;
}
const initialUi: UiSlice = { sidebarOpen: true, panelOpen: true, panelTab: "annotations", help: null, settingsOpen: false, menu: null, toast: null };

// ---------------------------------------------------------------- store

export interface Store {
  browser: BrowserSlice;
  slide: SlideSlice;
  annotations: AnnotationsSlice;
  filters: FiltersSlice;
  view: ViewSlice;
  ui: UiSlice;

  setBrowser: (p: Partial<BrowserSlice>) => void;
  setSlide: (p: Partial<SlideSlice>) => void;
  setAnnotations: (p: Partial<AnnotationsSlice>) => void;
  setFilters: (p: Partial<FiltersSlice>) => void;
  /** patch filter params (merges one level) */
  setFilterParams: (p: Partial<FilterParams>) => void;
  setView: (p: Partial<ViewSlice>) => void;
  setUi: (p: Partial<UiSlice>) => void;

  /** flush pending autosaves etc., then open a slide (resets annotations, view rotation/z and auto results) */
  /** open a slide; `series` picks an image of a multi-image file (SlideInfo.series), 0 by default */
  openSlide: (path: string, series?: number) => Promise<void>;
  closeSlide: () => Promise<void>;
  setTool: (tool: Tool) => void;
  select: (ids: string[]) => void;
  /** replace the annotation list as ONE undo step (marks the file dirty) */
  commit: (items: Annotation[]) => void;
  undo: () => void;
  redo: () => void;

  /** things that must finish before the slide changes or the app quits/updates (e.g. autosave) */
  flushers: Record<string, () => Promise<void>>;
  registerFlush: (name: string, fn: (() => Promise<void>) | null) => void;
  flushAll: () => Promise<void>;
}

/** ids of slides the backend holds open for us (the backend reuses one id per path) */
const backendOpen = new Set<number>();
/**
 * Close every backend slide except the one shown. While another open is still in flight (`pending`), only
 * slides that are not the shown one are closed when that one exists; the pending open releases the rest.
 */
function releaseHidden(shown: number | null, pending: boolean) {
  if (pending && shown === null) return; // the newest open hasn't finished: it will clean up when it does
  for (const id of [...backendOpen]) {
    if (id === shown) continue;
    backendOpen.delete(id);
    void backend.closeSlide(id).catch(() => {});
  }
}

export const useStore = create<Store>((set, get) => ({
  browser: initialBrowser,
  slide: initialSlide,
  annotations: initialAnnotations,
  filters: initialFilters,
  view: initialView,
  ui: initialUi,

  setBrowser: (p) => set((s) => ({ browser: { ...s.browser, ...p } })),
  setSlide: (p) => set((s) => ({ slide: { ...s.slide, ...p } })),
  setAnnotations: (p) => set((s) => ({ annotations: { ...s.annotations, ...p } })),
  setFilters: (p) => set((s) => ({ filters: { ...s.filters, ...p } })),
  setFilterParams: (p) => set((s) => ({ filters: { ...s.filters, params: { ...s.filters.params, ...p } } })),
  setView: (p) => set((s) => ({ view: { ...s.view, ...p } })),
  setUi: (p) => set((s) => ({ ui: { ...s.ui, ...p } })),

  openSlide: async (path, series = 0) => {
    await get().flushAll();
    // another image of the same file (Image / Position picker): keep the annotations and the view's
    // rotation; the annotations belong to the file
    const prev = get().slide.path === path ? get().slide.info : null;
    if (prev && prev.seriesIndex !== series) {
      set((s) => ({ slide: { ...s.slide, loading: true, error: null } }));
      try {
        const info = await backend.openSlide(path, series);
        backendOpen.add(info.id);
        if (get().slide.path === path)
          set((s) => ({
            slide: { ...s.slide, info, loading: false, openNonce: s.slide.openNonce + 1 },
            view: { ...s.view, z: 0, playing: false, t: Math.min(s.view.t, Math.max(0, info.timePoints.length - 1)) },
            filters: { ...s.filters, auto: initialAuto, analysis: null },
          }));
      } catch (e) {
        if (get().slide.path === path) set((s) => ({ slide: { ...s.slide, info: prev, loading: false }, ui: { ...s.ui, toast: { text: String(e), kind: "error" } } }));
      }
      releaseHidden(get().slide.info?.id ?? null, get().slide.loading);
      return;
    }
    set((s) => ({
      slide: { ...s.slide, path, info: null, loading: true, error: null },
      annotations: { ...initialAnnotations, tool: s.annotations.tool },
      view: { ...initialView, homeNonce: s.view.homeNonce },
      filters: { ...s.filters, auto: initialAuto },
    }));
    let info: SlideInfo | null = null;
    try {
      info = await backend.openSlide(path);
      backendOpen.add(info.id);
      if (get().slide.path === path) set((s) => ({ slide: { ...s.slide, info, loading: false, openNonce: s.slide.openNonce + 1 } }));
    } catch (e) {
      if (get().slide.path === path) set((s) => ({ slide: { ...s.slide, loading: false, error: String(e) } }));
    }
    // close every backend slide that isn't on screen: the previous one, and this one if another slide was
    // chosen while it opened (stepping quickly through a folder used to leak one open slide per step)
    releaseHidden(get().slide.info?.id ?? null, get().slide.loading);
  },
  closeSlide: async () => {
    await get().flushAll();
    set((s) => ({ slide: { ...initialSlide, openNonce: s.slide.openNonce }, annotations: { ...initialAnnotations, tool: s.annotations.tool } }));
    releaseHidden(null, false);
  },
  setTool: (tool) => set((s) => ({ annotations: { ...s.annotations, tool } })),
  select: (ids) => set((s) => ({ annotations: { ...s.annotations, selection: ids } })),
  commit: (items) =>
    set((s) => {
      const a = s.annotations;
      const ids = new Set(items.map((x) => x.id));
      return {
        annotations: {
          ...a,
          items,
          undo: [...a.undo, a.items].slice(-MAX_UNDO),
          redo: [],
          selection: a.selection.filter((id) => ids.has(id)),
          save: "dirty",
        },
      };
    }),
  undo: () =>
    set((s) => {
      const a = s.annotations;
      if (!a.undo.length) return {};
      const items = a.undo[a.undo.length - 1];
      return { annotations: { ...a, items, undo: a.undo.slice(0, -1), redo: [...a.redo, a.items], save: "dirty" } };
    }),
  redo: () =>
    set((s) => {
      const a = s.annotations;
      if (!a.redo.length) return {};
      const items = a.redo[a.redo.length - 1];
      return { annotations: { ...a, items, redo: a.redo.slice(0, -1), undo: [...a.undo, a.items], save: "dirty" } };
    }),

  flushers: {},
  registerFlush: (name, fn) =>
    set((s) => {
      const f = { ...s.flushers };
      if (fn) f[name] = fn;
      else delete f[name];
      return { flushers: f };
    }),
  flushAll: async () => {
    await Promise.all(Object.values(get().flushers).map((f) => f().catch((e) => console.error("flush failed", e))));
  },
}));
