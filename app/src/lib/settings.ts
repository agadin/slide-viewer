/**
 * Preferences (persisted in localStorage, shared live between the main and Preferences windows).
 * SHARED FILE. Each feature has its own sub-object, interface and defaults block below; a builder edits
 * ONLY its own block (they're far apart, so parallel edits merge cleanly). Unknown/missing keys are
 * filled from the defaults on load, so adding a field needs no migration.
 */
import { create } from "zustand";

// ================================================================ viewer (owner: viewer)
export interface ViewerSettings {
  /** zoom factor per scroll-wheel step */
  zoomPerScroll: number;
  dblClickZoom: boolean;
  /** smooth zoom / pan animation */
  animate: boolean;
  showNavigator: boolean;
  showScaleBar: boolean;
}
const viewerDefaults: ViewerSettings = {
  zoomPerScroll: 1.2,
  dblClickZoom: true,
  animate: true,
  showNavigator: true,
  showScaleBar: true,
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
}
const browserDefaults: BrowserSettings = {
  lastFolder: null,
  thumbSize: 72,
  reopenLastFolder: true,
  reopenLastSlide: true,
  lastSlide: null,
  collapsed: {},
};
// ================================================================ end browser

export interface Settings {
  viewer: ViewerSettings;
  annotations: AnnotationSettings;
  filters: FilterSettings;
  browser: BrowserSettings;
  /** collapsed panel sections (by id) */
  collapsed: string[];
}

export const defaultSettings: Settings = {
  viewer: viewerDefaults,
  annotations: annotationDefaults,
  filters: filterDefaults,
  browser: browserDefaults,
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
