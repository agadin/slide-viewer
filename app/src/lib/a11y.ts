/**
 * Visual accessibility: applies Preferences ▸ Accessibility (`settings.a11y`) to the page, and the pure
 * helpers behind it (contrast maths, colour names, the annotation display style).
 *
 * - `initA11y()` (main.tsx, every window) keeps <html> in sync with the settings and the OS:
 *   `--ts` (text scale), `--ann-scale`, and the classes `a11y-ts` (text larger than 100 %), `a11y-hc`
 *   (high contrast), `a11y-hc-off` (high contrast turned off although the OS asks for more contrast),
 *   `a11y-rm` (reduce motion) and `a11y-cb` (colour-blind-safe annotations). The CSS is in App.css.
 * - `useViewerSettings()` is `settings.viewer` with `animate` off while motion is reduced (SlideViewer).
 * - `annotationStyle()` is what `paintAnnotations` (lib/annotations.ts) reads for halos, label size,
 *   solid label backgrounds and colour names.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { useSettings, type A11ySettings, type A11yTri, type ViewerSettings } from "./settings";

// ================================================================ contrast (WCAG 2.x)

export type Rgba = [number, number, number, number];

/** "#rgb", "#rrggbb", "#rrggbbaa", "rgb(…)" or "rgba(…)" → [r, g, b, a] (0–255, a 0–1); null if unknown */
export function parseColor(c: string): Rgba | null {
  const s = c.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], a];
  }
  return null;
}

/** colour `fg` laid over the opaque `bg` */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

/** WCAG relative luminance of an opaque colour */
export function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** contrast ratio (1–21) of `fg` over `bg`; translucent colours are composited onto the layers below */
export function contrast(fg: string | Rgba, bg: string | Rgba, ...under: (string | Rgba)[]): number {
  const p = (c: string | Rgba) => (typeof c === "string" ? parseColor(c) : c) ?? [0, 0, 0, 1];
  // flatten the background stack from the bottom up
  let base: Rgba = [0, 0, 0, 1];
  for (const c of [...under].reverse().concat([bg]).map(p)) base = composite(c, base);
  const f = composite(p(fg), base);
  const [a, b] = [luminance(f), luminance(base)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ================================================================ colour names (colour-blind-safe labels)

/** a plain English name for an annotation colour, e.g. "#00ff00" → "green" */
export function colorName(c: string): string {
  const p = parseColor(c);
  if (!p) return "";
  const [r, g, b] = [p[0] / 255, p[1] / 255, p[2] / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.18 || d < 0.08) return l < 0.15 ? "black" : l > 0.85 ? "white" : "grey";
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const dark = l < 0.3;
  if (h < 15 || h >= 345) return dark ? "dark red" : l > 0.75 ? "pink" : "red";
  if (h < 40) return dark || (l < 0.4 && s < 0.7) ? "brown" : "orange";
  if (h < 70) return dark ? "olive" : "yellow";
  if (h < 160) return dark ? "dark green" : "green";
  if (h < 200) return "cyan";
  if (h < 255) return dark ? "navy" : "blue";
  if (h < 290) return "purple";
  return l > 0.7 ? "pink" : "magenta";
}

// ================================================================ effective settings

/** the OS preferences we follow when a setting says "system" */
interface OsPrefs {
  reducedMotion: boolean;
  moreContrast: boolean;
}
const mq = (q: string) => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(q) : null);
const readOs = (): OsPrefs => ({
  reducedMotion: !!mq("(prefers-reduced-motion: reduce)")?.matches,
  moreContrast: !!mq("(prefers-contrast: more)")?.matches,
});
export const useOsPrefs = create<OsPrefs>(() => readOs());

const tri = (v: A11yTri, os: boolean) => (v === "on" ? true : v === "off" ? false : os);
export const reduceMotionOn = (a: A11ySettings, os: Pick<OsPrefs, "reducedMotion"> = useOsPrefs.getState()) => tri(a.reduceMotion, os.reducedMotion);
export const highContrastOn = (a: A11ySettings, os: Pick<OsPrefs, "moreContrast"> = useOsPrefs.getState()) => tri(a.highContrast, os.moreContrast);

/** the text scales offered (100–200 %; WCAG 1.4.4 asks for 200 %) */
export const TEXT_SCALES = [1, 1.15, 1.3, 1.5, 1.75, 2] as const;
/** the pin / label scales offered */
export const ANNOTATION_SCALES = [1, 1.25, 1.5, 2] as const;
const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** the classes and CSS variables <html> should carry for these settings */
export function a11yRootState(a: A11ySettings, os: OsPrefs) {
  const ts = clamp(a.textScale, 1, 2, 1);
  const hc = highContrastOn(a, os);
  return {
    vars: { "--ts": String(ts), "--ann-scale": String(clamp(a.annotationScale, 1, 3, 1)) },
    classes: {
      "a11y-ts": ts > 1,
      "a11y-hc": hc,
      "a11y-hc-off": a.highContrast === "off",
      "a11y-rm": reduceMotionOn(a, os),
      "a11y-cb": !!a.colorBlindSafe,
    } as Record<string, boolean>,
  };
}

/** apply the settings to an element (document.documentElement) */
export function applyA11y(a: A11ySettings, root: HTMLElement, os: OsPrefs = useOsPrefs.getState()) {
  const st = a11yRootState(a, os);
  for (const [k, v] of Object.entries(st.vars)) root.style.setProperty(k, v);
  for (const [k, on] of Object.entries(st.classes)) root.classList.toggle(k, on);
}

let started = false;
/** keep <html> in sync with Preferences ▸ Accessibility and the OS (call once per window) */
export function initA11y() {
  if (started || typeof document === "undefined") return;
  started = true;
  const root = document.documentElement;
  const apply = () => applyA11y(useSettings.getState().s.a11y, root);
  apply();
  useSettings.subscribe((s, prev) => s.s.a11y !== prev.s.a11y && apply());
  useOsPrefs.subscribe(apply);
  for (const q of ["(prefers-reduced-motion: reduce)", "(prefers-contrast: more)"]) {
    const m = mq(q);
    m?.addEventListener?.("change", () => useOsPrefs.setState(readOs()));
  }
}

/** `settings.viewer`, with smooth zoom/pan off while motion is reduced */
export function useViewerSettings(): ViewerSettings {
  const v = useSettings((s) => s.s.viewer);
  const rm = useSettings((s) => s.s.a11y.reduceMotion);
  const os = useOsPrefs((s) => s.reducedMotion);
  const off = tri(rm, os);
  return useMemo(() => (off && v.animate ? { ...v, animate: false } : v), [v, off]);
}

// ================================================================ annotation display

export interface AnnotationStyle {
  /** pin icon size factor */
  pinScale: number;
  /** label font / padding factor */
  labelScale: number;
  /** draw a white-and-black halo round pins and shape outlines */
  halo: boolean;
  /** add the colour's name to labels */
  colorNames: boolean;
  /** opaque label background with a light border */
  solidLabels: boolean;
}

export function annotationStyleFor(a: A11ySettings, os: OsPrefs = useOsPrefs.getState()): AnnotationStyle {
  const k = clamp(a.annotationScale, 1, 3, 1);
  const hc = highContrastOn(a, os);
  return { pinScale: k, labelScale: k * (hc ? 1.15 : 1), halo: !!a.colorBlindSafe || hc, colorNames: !!a.colorBlindSafe, solidLabels: hc };
}

/** the annotation display style for the current settings (read by paintAnnotations) */
export const annotationStyle = (): AnnotationStyle => annotationStyleFor(useSettings.getState().s.a11y);
