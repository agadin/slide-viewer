/**
 * Preferences (persisted in localStorage, shared live between the main and Preferences windows).
 * SHARED FILE. Each feature has its own sub-object, interface and defaults block below; a builder edits
 * ONLY its own block (they're far apart, so parallel edits merge cleanly). Unknown/missing keys are
 * filled from the defaults on load, so adding a field needs no migration.
 */
import { create } from "zustand";

// ================================================================ viewer (owner: viewer)
export type ScaleBarPos = "bottom-left" | "bottom-right" | "top-left" | "top-right";
export interface ViewerSettings {
  /** zoom factor per scroll-wheel step */
  zoomPerScroll: number;
  dblClickZoom: boolean;
  /** smooth zoom / pan animation */
  animate: boolean;
  showNavigator: boolean;
  /** overview map: longest side in CSS px (drag its corner, or Preferences ▸ Viewing) */
  navSize: number;
  /** overview map: top-left corner within the slide area, px; null = the default top-left spot */
  navPos: { x: number; y: number } | null;
  showScaleBar: boolean;
  /** the zoom bar (presets + magnification readout, top right). Off by default: zoom lives in the right-click menu */
  showZoomBar: boolean;
  /** the floating tool bar at the bottom. Off by default: annotations are placed from the right-click menu */
  showToolbar: boolean;
  /** where the scale bar sits over the slide */
  scaleBarPos: ScaleBarPos;
  /** open the window in full screen at launch */
  openFullScreen: boolean;
  /** degrees per step for free rotation (Shift+, / Shift+. and Shift-click on the rotate buttons) */
  rotateStep: number;
  /** PNG snapshot options (remembered between snapshots) */
  snapshot: { scale: number; annotations: boolean; scaleBar: boolean; title: boolean };
}
const viewerDefaults: ViewerSettings = {
  zoomPerScroll: 1.2,
  dblClickZoom: true,
  animate: true,
  showNavigator: true,
  navSize: 200,
  navPos: null,
  showScaleBar: true,
  showZoomBar: false,
  showToolbar: false,
  scaleBarPos: "bottom-left",
  openFullScreen: false,
  rotateStep: 15,
  snapshot: { scale: 2, annotations: true, scaleBar: true, title: true },
};
// ================================================================ end viewer

// ================================================================ annotations (owner: annotations)
export interface AnnotationSettings {
  /** colour for new pins and shapes ("#rrggbb") */
  defaultColor: string;
  /** draw titles next to pins */
  showTitles: boolean;
  /** autosave delay after the last edit, ms */
  autosaveMs: number;
}
const annotationDefaults: AnnotationSettings = {
  defaultColor: "#00ff00",
  showTitles: true,
  autosaveMs: 1000,
};
// ================================================================ end annotations

// ================================================================ filters (owner: filters)
export interface FilterSettings {
  /** run these "Auto" steps automatically when a slide opens */
  autoOnOpen: { levels: boolean; stain: boolean; normalize: boolean };
}
const filterDefaults: FilterSettings = {
  autoOnOpen: { levels: false, stain: false, normalize: false },
};
// ================================================================ end filters

// ================================================================ browser (owner: browser)
export interface BrowserSettings {
  /** reopen this folder at launch */
  lastFolder: string | null;
  /** thumbnail width in the list, CSS px; 0 = no thumbnails (compact list) */
  thumbSize: number;
  /** open the last folder again when the app starts */
  reopenLastFolder: boolean;
  /** …and the slide that was open in it */
  reopenLastSlide: boolean;
  lastSlide: string | null;
  /** collapsed folders (ScanEntry.dir values) per scanned root, most recent last */
  collapsed: Record<string, string[]>;
  /** hide the slide browser after picking a slide from its list */
  hideOnPick: boolean;
  /** hide the slide browser after opening a slide with File ▸ Open… */
  hideOnOpenFile: boolean;
}
const browserDefaults: BrowserSettings = {
  lastFolder: null,
  thumbSize: 72,
  reopenLastFolder: true,
  reopenLastSlide: true,
  lastSlide: null,
  collapsed: {},
  hideOnPick: false,
  hideOnOpenFile: false,
};
// ================================================================ end browser

// ================================================================ a11y (owner: a11y visual)
/** "system" follows the OS setting (prefers-reduced-motion / prefers-contrast) */
export type A11yTri = "system" | "on" | "off";
export interface A11ySettings {
  /** UI text size: 1, 1.15, 1.3 or 1.5 (100–150 %) */
  textScale: number;
  /** opaque panels, stronger borders, solid annotation labels */
  highContrast: A11yTri;
  /** no smooth zoom/pan and no CSS transitions or animations */
  reduceMotion: A11yTri;
  /** a contrasting halo on pins and shapes, and the colour name in their labels */
  colorBlindSafe: boolean;
  /** pins and annotation labels drawn larger: 1, 1.25, 1.5 or 2 */
  annotationScale: number;
  /**
   * single-character shortcuts (V P R F C B X N M H 0 + − , . [ ] Space…) only work while the slide has the
   * keyboard focus (WCAG 2.1.4), so speech input and stray key presses elsewhere can't trigger them
   */
  singleKeysOnSlide: boolean;
}
export const a11yDefaults: A11ySettings = {
  textScale: 1,
  highContrast: "system",
  reduceMotion: "system",
  colorBlindSafe: false,
  annotationScale: 1,
  singleKeysOnSlide: false,
};
// ================================================================ end a11y

export interface Settings {
  viewer: ViewerSettings;
  annotations: AnnotationSettings;
  filters: FilterSettings;
  browser: BrowserSettings;
  a11y: A11ySettings;
  /** collapsed panel sections (by id) */
  collapsed: string[];
}

export const defaultSettings: Settings = {
  viewer: viewerDefaults,
  annotations: annotationDefaults,
  filters: filterDefaults,
  browser: browserDefaults,
  a11y: a11yDefaults,
  collapsed: [],
};

const KEY = "sv.settings.v1";

/** saved settings over the defaults, one level deep per feature block */
export function mergeSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const block = <T extends object>(d: T, v: unknown): T => (v && typeof v === "object" ? { ...d, ...(v as Partial<T>) } : d);
  return {
    viewer: block(viewerDefaults, s.viewer),
    annotations: block(annotationDefaults, s.annotations),
    filters: block(filterDefaults, s.filters),
    browser: block(browserDefaults, s.browser),
    a11y: block(a11yDefaults, s.a11y),
    collapsed: Array.isArray(s.collapsed) ? (s.collapsed as string[]) : [],
  };
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return mergeSettings(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return defaultSettings;
}

type Section = Exclude<keyof Settings, "collapsed">;

interface SettingsStore {
  s: Settings;
  /** patch one feature block: setSection("viewer", { animate: false }) */
  setSection: <K extends Section>(k: K, patch: Partial<Settings[K]>) => void;
  set: (patch: Partial<Settings>) => void;
  reset: () => void;
}

const persist = (s: Settings) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
};

export const useSettings = create<SettingsStore>((set, get) => ({
  s: typeof localStorage === "undefined" ? defaultSettings : load(),
  setSection: (k, patch) => {
    const s = { ...get().s, [k]: { ...get().s[k], ...patch } };
    persist(s);
    set({ s });
  },
  set: (patch) => {
    const s = { ...get().s, ...patch };
    persist(s);
    set({ s });
  },
  reset: () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    set({ s: defaultSettings });
  },
}));

// keep every window (main + Preferences) in sync: localStorage changes fire "storage" elsewhere
if (typeof window !== "undefined" && typeof window.addEventListener === "function")
  window.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === null) useSettings.setState({ s: load() });
  });

export const keyLabel = (k: string) => (k === " " ? "Space" : k.length === 1 ? k.toUpperCase() : k);
