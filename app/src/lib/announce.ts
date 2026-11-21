/**
 * Screen-reader announcements (WCAG 4.1.3 status messages). Owner: a11y (screen readers + semantics).
 *
 *   announce("Saved")                       polite: read when the reader is idle
 *   announce("Save failed: …", "assertive") interrupts
 *
 * Two visually hidden aria-live regions are added to <body> once (`mountAnnouncer`, called from App.tsx).
 * Messages sent in the same tick are joined; the region is cleared first so a repeated message is
 * read again. `useAnnouncements()` (App.tsx) watches the stores and announces slide opens, annotation
 * edits, undo/redo, saves, zoom (debounced), rotation, focal plane, the overview map and stain detection.
 *
 * Any feature may import `announce` for its own messages. The text helpers below are pure (tested in
 * tests/a11y-semantics.test.ts) and also feed the annotation list's and the viewer's accessible names.
 */
import { useEffect } from "react";
import { useStore, type Store } from "./store";
import { useSettings } from "./settings";
import { useAnnUi, KIND_LABEL, kindLabel, measureText } from "./annotations";
import { nearestPinColor, PIN_COLORS } from "./ndpa";
import { basename } from "./backend";
import { stainLabel } from "./filters/stain";
import type { Annotation, SlideInfo, StainAnalysis } from "./types";

export type Politeness = "polite" | "assertive";

// ================================================================ live regions

const HIDDEN_STYLE =
  "position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;";

const regions: Partial<Record<Politeness, HTMLElement>> = {};
const pending: Record<Politeness, string[]> = { polite: [], assertive: [] };
const timers: Partial<Record<Politeness, ReturnType<typeof setTimeout>>> = {};
/** the last messages, newest last (for tests and debugging) */
export const announceLog: { text: string; politeness: Politeness }[] = [];

function region(p: Politeness): HTMLElement | null {
  if (typeof document === "undefined") return null;
  let el = regions[p];
  if (el && el.isConnected) return el;
  el = document.getElementById(`sv-live-${p}`) ?? undefined;
  if (!el) {
    el = document.createElement("div");
    el.id = `sv-live-${p}`;
    el.className = "sv-live sr-only";
    el.setAttribute("aria-live", p);
    el.setAttribute("aria-atomic", "true");
    // role=status / alert make older readers honour the region; content starts empty, as it must
    el.setAttribute("role", p === "assertive" ? "alert" : "status");
    el.setAttribute("style", HIDDEN_STYLE);
    document.body.appendChild(el);
  }
  regions[p] = el;
  return el;
}

/** add the two live regions to the page (idempotent); returns a cleanup that removes them */
export function mountAnnouncer(): () => void {
  region("polite");
  region("assertive");
  return () => {
    for (const p of ["polite", "assertive"] as const) {
      clearTimeout(timers[p]);
      regions[p]?.remove();
      delete regions[p];
      pending[p] = [];
    }
  };
}

/** Say `text` to screen-reader users. Empty text is ignored. */
export function announce(text: string, politeness: Politeness = "polite"): void {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return;
  announceLog.push({ text: t, politeness });
  if (announceLog.length > 50) announceLog.shift();
  const el = region(politeness);
  if (!el) return;
  pending[politeness].push(t);
  if (timers[politeness]) return;
  el.textContent = "";
  timers[politeness] = setTimeout(() => {
    timers[politeness] = undefined;
    const msg = [...new Set(pending[politeness])].join(" ");
    pending[politeness] = [];
    el.textContent = msg;
  }, 60);
}

// ================================================================ spoken text (pure)

/** "245 µm · ⌀ 3 mm" → "245 micrometres, diameter 3 millimetres" */
export function spokenUnits(s: string): string {
  return s
    .replace(/µm²/g, " square micrometres")
    .replace(/mm²/g, " square millimetres")
    .replace(/px²/g, " square pixels")
    .replace(/µm/g, " micrometres")
    .replace(/(\d)\s*mm\b/g, "$1 millimetres")
    .replace(/(\d)\s*px\b/g, "$1 pixels")
    .replace(/⌀/g, "diameter")
    .replace(/\s×\s/g, " by ")
    .replace(/\s·\s/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** a colour's name: one of NDP.view's pin colours, or "custom colour near red" */
export function colorName(hex: string): string {
  const h = (hex ?? "").toLowerCase();
  const exact = PIN_COLORS.find((c) => c.hex === h);
  if (exact) return exact.name;
  return `custom colour near ${nearestPinColor(h).name}`;
}

/** "Pin", "Flag", "Ruler", "Open freehand line", … */
export function kindName(a: Pick<Annotation, "kind" | "pinStyle" | "closed">): string {
  if (a.kind === "pin" && a.pinStyle === "flag") return "Flag";
  if (a.kind === "freehand" && a.closed === false) return "Freehand line";
  return KIND_LABEL[a.kind];
}

const quoted = (title: string) => (title.trim() ? `“${title.trim()}”` : "Untitled");

/** full accessible name of an annotation-list row: `“Q1”, pin, green, 2 of 5` (+ measurement, hidden, duplicate) */
export function describeAnnotation(
  a: Pick<Annotation, "kind" | "title" | "color" | "points" | "radiusNm" | "closed" | "pinStyle">,
  opts: { index?: number; total?: number; calibrated?: boolean; hidden?: boolean; duplicate?: boolean } = {},
): string {
  const m = measureText(a, opts.calibrated ?? true);
  const parts = [quoted(a.title), kindName(a).toLowerCase()];
  if (m) parts.push(spokenUnits(m));
  parts.push(colorName(a.color));
  if (opts.hidden) parts.push("hidden");
  if (opts.duplicate) parts.push("title used more than once");
  if (opts.index != null && opts.total != null) parts.push(`${opts.index + 1} of ${opts.total}`);
  return parts.join(", ");
}

/**
 * The annotation list row's accessible name. It starts with exactly what the row shows ("Q1, Ruler · 245 µm")
 * so speech-input users can say what they see (WCAG 2.5.3 label in name), then adds what only colour or
 * position shows: the colour, hidden, a repeated title and "2 of 5".
 */
export function annotationRowName(
  a: Pick<Annotation, "title" | "kind" | "color">,
  measure: string | null,
  o: { index?: number; total?: number; hidden?: boolean; duplicate?: boolean } = {},
): string {
  const parts = [a.title.trim() || "Untitled", [kindLabel(a), measure].filter(Boolean).join(" · "), colorName(a.color)];
  if (o.hidden) parts.push("hidden");
  if (o.duplicate) parts.push("title used more than once");
  if (o.index != null && o.total != null) parts.push(`${o.index + 1} of ${o.total}`);
  return parts.join(", ");
}

/** "10×" → "10 times"; null/0 → "" */
export function spokenMag(mag: number | null | undefined): string {
  if (mag == null || !Number.isFinite(mag) || mag <= 0) return "";
  const v = mag >= 100 ? Math.round(mag) : mag >= 10 ? +mag.toFixed(1) : +mag.toFixed(2);
  return `${v} times`;
}

/** what the zoom is, in words: "magnification 10 times" or, uncalibrated, "zoom 50 percent" */
export function spokenZoom(info: Pick<SlideInfo, "calibrated"> | null, mag: number | null, umPerScreenPx: number | null): string {
  if (!info) return "";
  if (!info.calibrated) {
    if (!umPerScreenPx) return "";
    const pct = 100 / umPerScreenPx;
    return `zoom ${pct >= 10 ? Math.round(pct) : +pct.toFixed(1)} percent`;
  }
  const m = spokenMag(mag);
  return m ? `magnification ${m}` : "";
}

const n = (x: number) => Math.round(x).toLocaleString("en-US");
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** the slide's size and calibration: "100,000 by 60,000 pixels, 0.442 micrometres per pixel" */
export function slideFacts(info: SlideInfo): string {
  const size = `${n(info.width)} by ${n(info.height)} pixels`;
  const cal = info.calibrated ? `${+info.mppX.toFixed(3)} micrometres per pixel` : "uncalibrated, so measurements are in pixels";
  const z = info.zPlanes.length > 1 ? `, ${info.zPlanes.length} focal planes` : "";
  const t = (info.timePoints?.length ?? 0) > 1 ? `, ${info.timePoints.length} time points` : "";
  const ser = (info.series?.length ?? 0) > 1 ? `, ${info.seriesKind.toLowerCase()} ${info.seriesIndex + 1} of ${info.series.length}` : "";
  return `${size}, ${cal}${z}${t}${ser}`;
}

export const KEY_HINT =
  "X turns on the keyboard cursor: then the arrow keys pan the slide under it, P places a pin there and Space clicks. " +
  "Plus and minus zoom, H fits the slide, comma and period rotate, M shows the overview map, " +
  "V P R F C B choose the pan, pin, ruler, freehand, circle and rectangle tools, square brackets go to the previous or next slide. " +
  "N goes to the next annotation, F2 renames it, Shift F10 opens its menu. Tab leaves the slide. " +
  "All shortcuts are in Help, Keyboard shortcuts, and Help, Accessibility.";

/** spoken stain detection result: "Stain detected: H&E, 82 percent confidence" */
export function stainMessage(a: Pick<StainAnalysis, "stainType" | "subtype" | "confidence">): string {
  return `Stain detected: ${stainLabel(a.stainType, a.subtype)}, ${Math.round(a.confidence * 100)} percent confidence.`;
}

/** "Opened VMS104.ndpi. 3 annotations. H&E. magnification 1.25 times." */
export function openedMessage(p: { name: string; annotations: number; zoom: string; stain?: string | null }): string {
  const parts = [`Opened ${p.name}.`, p.annotations ? `${plural(p.annotations, "annotation")}.` : "No annotations."];
  if (p.stain) parts.push(`${p.stain}.`);
  if (p.zoom) parts.push(`${p.zoom[0].toUpperCase()}${p.zoom.slice(1)}.`);
  return parts.join(" ");
}

export interface AnnotationDiff {
  added: Annotation[];
  removed: Annotation[];
  renamed: Annotation[];
  moved: Annotation[];
  recolored: Annotation[];
  other: number;
}

const samePoints = (a: Annotation, b: Annotation) =>
  a.radiusNm === b.radiusNm && a.points.length === b.points.length && a.points.every((p, i) => p.x === b.points[i].x && p.y === b.points[i].y);

/** what changed between two annotation lists (by id) */
export function diffAnnotations(prev: readonly Annotation[], next: readonly Annotation[]): AnnotationDiff {
  const before = new Map(prev.map((a) => [a.id, a]));
  const after = new Set(next.map((a) => a.id));
  const d: AnnotationDiff = { added: [], removed: [], renamed: [], moved: [], recolored: [], other: 0 };
  for (const a of next) {
    const b = before.get(a.id);
    if (!b) d.added.push(a);
    else if (b !== a) {
      if (b.title !== a.title) d.renamed.push(a);
      else if (!samePoints(a, b)) d.moved.push(a);
      else if (b.color !== a.color) d.recolored.push(a);
      else d.other++;
    }
  }
  for (const a of prev) if (!after.has(a.id)) d.removed.push(a);
  return d;
}

/** one sentence for a diff ("" when nothing worth saying changed) */
export function diffMessage(d: AnnotationDiff): string {
  const out: string[] = [];
  const one = (list: Annotation[], verb: string) => {
    if (list.length === 1) out.push(`${kindName(list[0])} ${quoted(list[0].title)} ${verb}.`);
    else if (list.length > 1) out.push(`${plural(list.length, "annotation")} ${verb}.`);
  };
  one(d.added, "added");
  one(d.removed, "deleted");
  if (d.renamed.length === 1) out.push(`Renamed to ${quoted(d.renamed[0].title)}.`);
  else if (d.renamed.length > 1) out.push(`${d.renamed.length} annotations renamed.`);
  one(d.moved, "moved");
  if (d.recolored.length === 1) out.push(`${quoted(d.recolored[0].title)} is now ${colorName(d.recolored[0].color)}.`);
  else if (d.recolored.length > 1) out.push(`${d.recolored.length} annotations recoloured.`);
  if (!out.length && d.other) out.push(d.other === 1 ? "Annotation changed." : `${d.other} annotations changed.`);
  return out.join(" ");
}

/** how the annotation list changed between two store states */
export function annotationChangeKind(prev: Store["annotations"], next: Store["annotations"]): "undo" | "redo" | "edit" | null {
  if (prev.items === next.items) return null;
  if (prev.undo.length && next.items === prev.undo[prev.undo.length - 1] && next.redo.length === prev.redo.length + 1) return "undo";
  if (prev.redo.length && next.items === prev.redo[prev.redo.length - 1] && next.undo.length >= 1) return "redo";
  if (next.undo !== prev.undo && next.undo.length > 0) return "edit";
  return null; // a load / reset
}

/** "Time point 3 of 10, 1 min 0 s" */
export function timeMessage(info: Pick<SlideInfo, "timePoints">, t: number): string {
  const times = info.timePoints ?? [];
  const i = times.findIndex((p) => p.index === t);
  if (i < 0 || times.length <= 1) return "";
  const unit = (n: string, one: string) => `${+n} ${+n === 1 ? one : `${one}s`}`;
  const spoken = /^T \d+$/.test(times[i].label)
    ? ""
    : times[i].label
        .replace(/([\d.]+) h\b/, (_, n) => unit(n, "hour"))
        .replace(/([\d.]+) min\b/, (_, n) => unit(n, "minute"))
        .replace(/([\d.]+) s\b/, (_, n) => unit(n, "second"));
  return `Time point ${i + 1} of ${times.length}${spoken ? `, ${spoken}` : ""}.`;
}

/** "Focal plane 3 of 5, +1.2 µm" */
export function planeMessage(info: Pick<SlideInfo, "zPlanes">, z: number): string {
  const planes = info.zPlanes;
  const i = planes.findIndex((p) => p.index === z);
  if (i < 0 || planes.length <= 1) return "";
  const p = planes[i];
  const label = p.label || (p.offsetNm != null ? `${(p.offsetNm / 1000).toFixed(1)} µm` : "");
  return `Focal plane ${i + 1} of ${planes.length}${label ? `, ${spokenUnits(label)}` : ""}.`;
}

/** "Rotated to 90 degrees" / "Rotation reset" */
export const rotationMessage = (deg: number) => {
  const d = Math.round(((deg % 360) + 360) % 360);
  return d === 0 ? "Rotation 0 degrees." : `Rotated to ${d} degrees.`;
};

/** zoom changes worth saying: more than 4 % away from what was said last */
export const zoomChanged = (last: number | null, now: number) => last == null || Math.abs(now - last) / Math.max(last, 1e-9) > 0.04;

/**
 * aria-level / aria-setsize / aria-posinset for a flattened tree (rows in display order, `depth` 0 = top level).
 * Siblings are the consecutive rows at one depth under the same parent row.
 */
export function treePositions(rows: readonly { key: string; depth: number }[]): Map<string, { level: number; setsize: number; posinset: number }> {
  const out = new Map<string, { level: number; setsize: number; posinset: number }>();
  const groups: string[][] = [];
  const close = (fromDepth: number) => {
    for (let d = groups.length - 1; d >= fromDepth; d--) {
      const g = groups[d];
      if (g) for (const k of g) out.get(k)!.setsize = g.length;
    }
    groups.length = Math.min(groups.length, fromDepth);
  };
  for (const r of rows) {
    const d = Math.max(0, r.depth);
    close(d + 1);
    const g = (groups[d] ??= []);
    g.push(r.key);
    out.set(r.key, { level: d + 1, setsize: 0, posinset: g.length });
  }
  close(0);
  return out;
}

const UNIT_WORDS: Record<string, string> = { "%": "percent", "°": "degrees", px: "pixels", "µm": "micrometres" };
/** aria-valuetext for a slider: "Gamma 1.20", "Brightness 25 percent", "Hue -30 degrees" */
export function sliderValueText(label: string, shown: number, digits = 0, unit?: string): string {
  const v = Number.isFinite(shown) ? shown.toFixed(digits) : "";
  const u = unit ? ` ${UNIT_WORDS[unit] ?? unit}` : "";
  return `${label} ${v.replace(/^-/, "minus ")}${u}`;
}

/** the document title for a slide */
export const documentTitle = (slidePath: string | null) => (slidePath ? `${basename(slidePath)} — Slide Viewer` : "Slide Viewer");

// ================================================================ store watcher (App.tsx)

const ZOOM_DELAY = 700;
const ROTATE_DELAY = 400;
const OPEN_DELAY = 900;

/** Announce app events from the stores. Call once (App.tsx). */
export function useAnnouncements(): void {
  useEffect(() => {
    const unmount = mountAnnouncer();
    let zoomTimer: ReturnType<typeof setTimeout> | undefined;
    let rotTimer: ReturnType<typeof setTimeout> | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let lastZoom: number | null = null;
    /** true from a slide open until its summary has been read (zoom and stain wait for it) */
    let opening = false;
    /** saved once since the slide opened (later autosaves are quiet) */
    let savedOnce = false;
    let lastSave = useStore.getState().annotations.save;

    const zoomValue = (s: Store) => (s.slide.info?.calibrated ? s.view.magnification : s.view.umPerScreenPx ? 1 / s.view.umPerScreenPx : null);

    const unStore = useStore.subscribe((s, prev) => {
      // ---- slide opened / failed
      if (s.slide.openNonce !== prev.slide.openNonce && s.slide.info && s.slide.path) {
        opening = true;
        savedOnce = false;
        clearTimeout(openTimer);
        clearTimeout(zoomTimer);
        const path = s.slide.path;
        openTimer = setTimeout(() => {
          opening = false;
          const st = useStore.getState();
          if (st.slide.path !== path || !st.slide.info) return;
          lastZoom = zoomValue(st);
          const an = st.filters.analysis;
          announce(
            openedMessage({
              name: basename(path),
              annotations: st.annotations.items.length,
              zoom: spokenZoom(st.slide.info, st.view.magnification, st.view.umPerScreenPx),
              stain: an ? `${stainLabel(an.stainType, an.subtype)} stain detected` : null,
            }),
          );
        }, OPEN_DELAY);
      }
      if (s.slide.loading && !prev.slide.loading && s.slide.path) announce(`Opening ${basename(s.slide.path)}…`);
      if (s.slide.error && s.slide.error !== prev.slide.error) announce(`Could not open the slide: ${s.slide.error}`, "assertive");

      // ---- annotations
      const a = s.annotations, pa = prev.annotations;
      const kind = s.slide.path === prev.slide.path ? annotationChangeKind(pa, a) : null;
      if (kind) {
        const msg = diffMessage(diffAnnotations(pa.items, a.items));
        if (kind === "undo") announce(`Undo. ${msg}`);
        else if (kind === "redo") announce(`Redo. ${msg}`);
        else if (msg) announce(msg);
      }

      // ---- saving
      if (a.save !== lastSave) {
        if (a.save === "error") announce(`Annotations not saved: ${a.saveError ?? "unknown error"}`, "assertive");
        else if (a.save === "saved" && (lastSave === "error" || !savedOnce)) announce(lastSave === "error" ? "Annotations saved again." : "Annotations saved.");
        if (a.save === "saved") savedOnce = true;
        lastSave = a.save;
      }

      // ---- view
      if (s.slide.info && s.slide.path === prev.slide.path && !opening) {
        const zv = zoomValue(s);
        if (zv != null && zv !== zoomValue(prev)) {
          clearTimeout(zoomTimer);
          zoomTimer = setTimeout(() => {
            const st = useStore.getState();
            const now = zoomValue(st);
            if (now == null || !zoomChanged(lastZoom, now)) return;
            lastZoom = now;
            const t = spokenZoom(st.slide.info, st.view.magnification, st.view.umPerScreenPx);
            if (t) announce(`${t[0].toUpperCase()}${t.slice(1)}.`);
          }, ZOOM_DELAY);
        }
        if (s.view.rotation !== prev.view.rotation) {
          clearTimeout(rotTimer);
          rotTimer = setTimeout(() => announce(rotationMessage(useStore.getState().view.rotation)), ROTATE_DELAY);
        }
        if (prev.slide.info && s.slide.info !== prev.slide.info && s.slide.path === prev.slide.path && s.slide.info.seriesIndex !== prev.slide.info.seriesIndex) {
          const i = s.slide.info;
          announce(`${i.seriesKind} ${i.seriesIndex + 1} of ${i.series.length}: ${i.series[i.seriesIndex] ?? ""}. ${slideFacts({ ...i, series: [] })}.`);
        }
        if (s.view.z !== prev.view.z) {
          const m = planeMessage(s.slide.info, s.view.z);
          if (m) announce(m);
        }
        // time points: not while playing (one message per frame would drown everything else)
        if (s.view.t !== prev.view.t && !s.view.playing) {
          const m = timeMessage(s.slide.info, s.view.t);
          if (m) announce(m);
        }
        if (s.view.playing !== prev.view.playing) announce(s.view.playing ? "Playing the time series." : `Paused. ${timeMessage(s.slide.info, s.view.t)}`);
      }

      // ---- stain detection (the open summary includes it when it's already known)
      if (s.filters.analysis && s.filters.analysis !== prev.filters.analysis && !opening) announce(stainMessage(s.filters.analysis));
      if (s.filters.auto.status === "error" && prev.filters.auto.status !== "error" && s.filters.auto.error)
        announce(`Analysis failed: ${s.filters.auto.error}`, "assertive");
    });

    const unAnn = useAnnUi.subscribe((s, prev) => {
      if (s.notice && s.notice !== prev.notice) announce(s.notice);
      if (s.loadError && s.loadError !== prev.loadError) announce(s.loadError, "assertive");
    });

    const unSettings = useSettings.subscribe((s, prev) => {
      const on = s.s.viewer.showNavigator, was = prev.s.viewer.showNavigator;
      if (on !== was && useStore.getState().slide.info) announce(on ? "Overview map shown." : "Overview map hidden.");
    });

    return () => {
      clearTimeout(zoomTimer);
      clearTimeout(rotTimer);
      clearTimeout(openTimer);
      unStore();
      unAnn();
      unSettings();
      unmount();
    };
  }, []);

  // document title: "<slide> — Slide Viewer"
  const path = useStore((s) => s.slide.path);
  useEffect(() => {
    document.title = documentTitle(path);
  }, [path]);
}
