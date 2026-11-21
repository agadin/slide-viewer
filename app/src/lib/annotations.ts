/**
 * Annotation model helpers, hit-testing and painting. Owner: annotations (CONTRACTS.md).
 *
 * - Model: pure helpers that make / move / reshape annotations (geometry is always NDP.view nm), plus
 *   store actions (`addAnnotation`, `updateAnnotation`, `deleteAnnotations`) that go through
 *   `store.commit` so each is ONE undo step (undo/redo themselves live in the store).
 * - View-only state that is never saved (hidden ids, the read-only notice, jump requests) lives in the
 *   small `useAnnUi` store here, so the shared store doesn't need new fields.
 * - CONTRACT: `paintAnnotations(ctx, coords, items, opts)` draws annotations onto a 2D canvas in screen
 *   space (the canvas' CSS px; `opts.scale` = device pixel ratio). Snapshot calls it to burn them into PNGs.
 */
import { create } from "zustand";
import type { Annotation, AnnotationKind, PinStyle, PtNm } from "./types";
import type { ViewerCoords } from "./viewerContext";
import type { Pt } from "./coords";
import { uid } from "./util";
import { useStore } from "./store";
import { area, dist, fmtArea, fmtLength, perimeter } from "./measure";
import { anchorOf, nearestPinColor, newSource, nextNdpaId, type NdpaDocument } from "./ndpa";
import { annotationStyle, colorName, type AnnotationStyle } from "./a11y"; // a11y(visual)

/** a new app-local annotation id */
export const newAnnotationId = () => `a${uid()}`;

// ================================================================ view-only state (not saved)

export interface AnnUiState {
  /** annotations hidden from the view (per slide, not saved) */
  hidden: string[];
  /** e.g. "This folder is read-only: annotations are saved in the app's data folder." */
  notice: string | null;
  /** the slide's .ndpa could not be read; autosave won't overwrite it */
  loadError: string | null;
  /** ask the viewer to show an annotation (the panel lives outside the viewer) */
  jump: { id: string; nonce: number } | null;
  /** a11y(keyboard): the keyboard cursor (a reticle fixed at the view centre; X toggles it) */
  kbCursor?: boolean;
}
export const useAnnUi = create<AnnUiState>(() => ({ hidden: [], notice: null, loadError: null, jump: null, kbCursor: false }));

export const toggleHidden = (id: string) =>
  useAnnUi.setState((s) => ({ hidden: s.hidden.includes(id) ? s.hidden.filter((x) => x !== id) : [...s.hidden, id] }));
export const requestJump = (id: string) => useAnnUi.setState((s) => ({ jump: { id, nonce: (s.jump?.nonce ?? 0) + 1 } }));

// ================================================================ labels and measurements

/** "Pin", "Flag", "Ruler", …: what the list and announcements call an annotation */
export const kindLabel = (a: Pick<Annotation, "kind" | "pinStyle">) => (a.kind === "pin" && a.pinStyle === "flag" ? "Flag" : KIND_LABEL[a.kind]);

export const KIND_LABEL: Record<AnnotationKind, string> = {
  pin: "Pin",
  ruler: "Ruler",
  freehand: "Freehand",
  circle: "Circle",
  rectangle: "Rectangle",
  other: "Shape",
};

/** a length in nm: µm/mm, or px on an uncalibrated slide (stored at 1 µm/px, so 1 px = 1000 nm) */
export const fmtLen = (nm: number, calibrated = true) => (calibrated ? fmtLength(nm) : `${fmtPx(nm / 1000)} px`);
export const fmtAr = (nm2: number, calibrated = true) => (calibrated ? fmtArea(nm2) : `${fmtPx(nm2 / 1e6)} px²`);
const fmtPx = (v: number) => (v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1));

/** what the annotation measures: "245 µm", "0.031 mm²", … (null for pins) */
export function measureText(a: Pick<Annotation, "kind" | "points" | "radiusNm" | "closed">, calibrated = true): string | null {
  switch (a.kind) {
    case "ruler":
      return a.points.length >= 2 ? fmtLen(dist(a.points[0], a.points[a.points.length - 1]), calibrated) : null;
    case "circle": {
      const r = a.radiusNm ?? 0;
      return `${fmtAr(Math.PI * r * r, calibrated)} · ⌀ ${fmtLen(2 * r, calibrated)}`;
    }
    case "rectangle": {
      const w = dist(a.points[0], a.points[1]), h = dist(a.points[1], a.points[2] ?? a.points[1]);
      return `${fmtLen(w, calibrated)} × ${fmtLen(h, calibrated)} · ${fmtAr(area(a.points), calibrated)}`;
    }
    case "freehand":
      if (a.closed === false) return fmtLen(polylineLength(a.points), calibrated);
      return a.points.length >= 3 ? `${fmtAr(area(a.points), calibrated)} · perimeter ${fmtLen(perimeter(a.points), calibrated)}` : null;
    default:
      return null;
  }
}
export const polylineLength = (pts: PtNm[]) => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);

/** titles used by more than one annotation (trimmed, case-insensitive; empty titles ignored) → their ids */
export function duplicateTitles(items: readonly Annotation[]): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const a of items) {
    const k = a.title.trim().toLowerCase();
    if (!k) continue;
    by.set(k, [...(by.get(k) ?? []), a.id]);
  }
  for (const [k, ids] of by) if (ids.length < 2) by.delete(k);
  return by;
}

/** "Pin 3": the next free default title for a kind */
export function defaultTitle(kind: AnnotationKind, items: readonly Annotation[]): string {
  const label = KIND_LABEL[kind];
  const taken = new Set(items.map((a) => a.title.trim().toLowerCase()));
  for (let n = items.filter((a) => a.kind === kind).length + 1; ; n++) if (!taken.has(`${label} ${n}`.toLowerCase())) return `${label} ${n}`;
}

// ================================================================ geometry (pure, nm)

const rnd = (p: PtNm): PtNm => ({ x: Math.round(p.x), y: Math.round(p.y) });
export const roundPts = (pts: PtNm[]) => pts.map(rnd);

/** the axis-aligned rectangle (in slide coordinates) with corners a and b: [a, ·, b, ·] */
export const rectFrom = (a: PtNm, b: PtNm): PtNm[] => roundPts([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]);

export function moveBy<T extends Pick<Annotation, "points">>(a: T, dx: number, dy: number): T {
  return { ...a, points: a.points.map((p) => rnd({ x: p.x + dx, y: p.y + dy })) };
}
export function withVertex<T extends Pick<Annotation, "points">>(a: T, i: number, p: PtNm): T {
  return { ...a, points: a.points.map((q, j) => (j === i ? rnd(p) : q)) };
}

/** bounds in nm (circles include their radius) */
export function boundsNm(a: Pick<Annotation, "points" | "radiusNm">): { x0: number; y0: number; x1: number; y1: number } {
  const r = a.radiusNm ?? 0;
  const xs = a.points.map((p) => p.x), ys = a.points.map((p) => p.y);
  return { x0: Math.min(...xs) - r, y0: Math.min(...ys) - r, x1: Math.max(...xs) + r, y1: Math.max(...ys) + r };
}

/** a new annotation made in this app (rounded to whole nm, with the next ndpviewstate id) */
export function makeAnnotation(
  kind: AnnotationKind,
  points: PtNm[],
  o: { color: string; items: readonly Annotation[]; doc?: unknown; title?: string; radiusNm?: number; closed?: boolean; lens?: number | null; z?: number; pinStyle?: PinStyle },
): Annotation {
  const color = kind === "pin" ? nearestPinColor(o.color).hex : o.color;
  const a: Annotation = {
    id: newAnnotationId(),
    ndpaId: nextNdpaId(o.doc as NdpaDocument | null, o.items),
    kind,
    title: o.title ?? defaultTitle(kind, o.items),
    details: "",
    color,
    points: roundPts(points),
    source: newSource(o.lens ?? null, o.z ?? 0),
  };
  if (kind === "circle") a.radiusNm = Math.round(o.radiusNm ?? 0);
  if (kind === "pin" && o.pinStyle === "flag") a.pinStyle = "flag";
  if (kind === "freehand" || kind === "rectangle") a.closed = kind === "rectangle" ? true : (o.closed ?? true);
  return a;
}

// ================================================================ store actions (one undo step each)

const items = () => useStore.getState().annotations.items;

export function addAnnotation(a: Annotation, select = true) {
  useStore.getState().commit([...items(), a]);
  if (select) useStore.getState().select([a.id]);
}
export function updateAnnotation(id: string, patch: Partial<Annotation>) {
  const cur = items();
  const a = cur.find((x) => x.id === id);
  if (!a) return;
  const next = { ...a, ...patch };
  if (patch.color && a.kind === "pin") next.color = nearestPinColor(patch.color).hex;
  if (JSON.stringify({ ...a, source: 0 }) === JSON.stringify({ ...next, source: 0 })) return;
  useStore.getState().commit(cur.map((x) => (x.id === id ? next : x)));
}
/** replace one annotation with an edited copy (drag results) */
export const replaceAnnotation = (a: Annotation) => useStore.getState().commit(items().map((x) => (x.id === a.id ? a : x)));
export function deleteAnnotations(ids: readonly string[]) {
  if (!ids.length) return;
  const del = new Set(ids);
  const cur = items();
  if (!cur.some((a) => del.has(a.id))) return;
  useStore.getState().commit(cur.filter((a) => !del.has(a.id)));
}
export const renameAnnotation = (id: string, title: string) => updateAnnotation(id, { title: title.trim() });

/** can this annotation's geometry be edited here? (NDP.view types we don't model are kept as they are) */
export const editable = (a: Pick<Annotation, "kind">) => a.kind !== "other";

// ================================================================ keyboard operation (a11y: WCAG 2.1.1)
// Pure helpers behind the keyboard cursor in AnnotationLayer.tsx and N / ⇧N in lib/keys.ts.

/** the keyboard cursor on / off */
export const setKbCursor = (on: boolean) => useAnnUi.setState({ kbCursor: on });

/** pan steps (fractions of the view) while the keyboard cursor is on: arrows, ⇧ arrows */
export const KB_PAN_STEP = 0.1;
export const KB_PAN_BIG = 0.25;
/** nudge steps for the selection (screen px): ⌥ arrows, ⌥⇧ arrows */
export const KB_NUDGE_PX = 5;
export const KB_NUDGE_BIG_PX = 25;

/**
 * the next (dir 1) or previous (dir -1) annotation to select when stepping through them with N / ⇧N:
 * list order, hidden ones skipped, wrapping round; from no selection N picks the first and ⇧N the last
 */
export function cycleAnnotation(
  list: readonly Pick<Annotation, "id">[],
  hidden: readonly string[],
  selection: readonly string[],
  dir: 1 | -1,
): string | null {
  const hid = new Set(hidden);
  const ids = list.map((a) => a.id).filter((id) => !hid.has(id));
  if (!ids.length) return null;
  const cur = selection.length ? ids.indexOf(selection[selection.length - 1]) : -1;
  if (cur < 0) return dir > 0 ? ids[0] : ids[ids.length - 1];
  return ids[(cur + dir + ids.length) % ids.length];
}

/** a two-point shape (keyboard cursor: first point, second point) */
export function shapeFromPoints(tool: "ruler" | "circle" | "rectangle", a: PtNm, b: PtNm): { points: PtNm[]; radiusNm?: number } {
  if (tool === "ruler") return { points: roundPts([a, b]) };
  if (tool === "circle") return { points: roundPts([a]), radiusNm: Math.max(1, Math.round(dist(a, b))) };
  return { points: rectFrom(a, b) };
}

/** move the annotations with these ids by (dx, dy) nm; the ones that can't be edited stay put */
export function nudgeAnnotations(list: readonly Annotation[], ids: readonly string[], dx: number, dy: number): Annotation[] {
  const sel = new Set(ids);
  return list.map((a) => (sel.has(a.id) && editable(a) ? moveBy(a, dx, dy) : a));
}

/** move the selection by (dx, dy) nm as one undo step; false when nothing could move */
export function nudgeSelection(dx: number, dy: number): boolean {
  const st = useStore.getState();
  const ids = st.annotations.selection;
  if (!ids.length || (!dx && !dy)) return false;
  const cur = st.annotations.items;
  const next = nudgeAnnotations(cur, ids, dx, dy);
  if (next.every((a, i) => a === cur[i])) return false;
  st.commit(next);
  return true;
}

// ================================================================ screen-space hit testing

/** pin look (NDP.view's push-pin): needle tip at the point, head up and to the right */
export const PIN_SIZE = 20;
/** the grab point of a pin's icon: the ball of a push-pin, the middle of a flag's cloth */
export const pinHead = (p: Pt, size = PIN_SIZE, style?: PinStyle): Pt =>
  style === "flag" ? { x: p.x + size * 0.31, y: p.y - size * 0.84 } : { x: p.x + size * 0.62, y: p.y - size * 0.62 };

const distToSeg = (p: Pt, a: Pt, b: Pt) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};
function inside(p: Pt, poly: Pt[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

export type Handle = { kind: "vertex"; index: number } | { kind: "radius" };
export interface Hit {
  id: string;
  /** "edge": on the outline or a pin; "inside": in a closed shape's interior; "handle": an edit handle of a selected shape */
  part: "edge" | "inside" | "handle";
  handle?: Handle;
}

const MAX_HANDLES = 400;
/** edit handles of an annotation in screen space */
export function handlesOf(coords: ViewerCoords, a: Annotation): { h: Handle; p: Pt }[] {
  if (!editable(a) || a.kind === "pin") return [];
  if (a.kind === "circle") {
    const c = coords.nmToScreen(a.points[0]);
    const r = (a.radiusNm ?? 0) * coords.screenPxPerNm();
    return [{ h: { kind: "radius" }, p: { x: c.x + r, y: c.y } }];
  }
  if (a.points.length > MAX_HANDLES) return [];
  return a.points.map((p, index) => ({ h: { kind: "vertex", index }, p: coords.nmToScreen(p) }));
}

/** the topmost annotation at screen point p (handles of selected annotations first) */
export function hitTest(
  coords: ViewerCoords,
  list: readonly Annotation[],
  p: Pt,
  o: { selection?: readonly string[]; hidden?: readonly string[]; tol?: number } = {},
): Hit | null {
  const tol = o.tol ?? 6;
  const hidden = new Set(o.hidden ?? []);
  const sel = new Set(o.selection ?? []);
  const vis = list.filter((a) => !hidden.has(a.id));
  for (let i = vis.length - 1; i >= 0; i--) {
    const a = vis[i];
    if (!sel.has(a.id)) continue;
    for (const { h, p: q } of handlesOf(coords, a)) if (Math.hypot(p.x - q.x, p.y - q.y) <= tol + 2) return { id: a.id, part: "handle", handle: h };
  }
  let insideHit: Hit | null = null;
  for (let i = vis.length - 1; i >= 0; i--) {
    const a = vis[i];
    const s = a.points.map((q) => coords.nmToScreen(q));
    if (a.kind === "pin") {
      const ps = PIN_SIZE * annotationStyle().pinScale; // a11y(visual): larger pins are hit where they're drawn
      const head = pinHead(s[0], ps, a.pinStyle);
      if (Math.hypot(p.x - head.x, p.y - head.y) <= ps * 0.45 || distToSeg(p, s[0], head) <= tol) return { id: a.id, part: "edge" };
      continue;
    }
    if (a.kind === "circle") {
      const r = (a.radiusNm ?? 0) * coords.screenPxPerNm();
      const d = Math.hypot(p.x - s[0].x, p.y - s[0].y);
      if (Math.abs(d - r) <= tol) return { id: a.id, part: "edge" };
      if (d < r && !insideHit) insideHit = { id: a.id, part: "inside" };
      continue;
    }
    const closed = a.kind === "rectangle" || (a.kind === "freehand" && a.closed !== false);
    if (s.length === 1) {
      if (Math.hypot(p.x - s[0].x, p.y - s[0].y) <= tol + 2) return { id: a.id, part: "edge" };
      continue;
    }
    for (let k = 1; k < s.length + (closed ? 1 : 0); k++) if (distToSeg(p, s[k - 1], s[k % s.length]) <= tol) return { id: a.id, part: "edge" };
    if (closed && !insideHit && inside(p, s)) insideHit = { id: a.id, part: "inside" };
  }
  return insideHit;
}

// ================================================================ painting

export interface PaintOptions {
  selection?: ReadonlySet<string>;
  showTitles?: boolean;
  /** device pixel ratio of the canvas (default 1) */
  scale?: number;
  /** ids not to draw (default: the ones hidden in the annotation list) */
  hidden?: ReadonlySet<string>;
  /** false on an uncalibrated slide: measurements in px (default: the open slide's calibration) */
  calibrated?: boolean;
  /** an annotation whose title is being edited inline (its label isn't drawn) */
  editingId?: string | null;
}

const INK = "rgba(18,18,18,0.9)";
const FONT = '500 12px "IBM Plex Sans", -apple-system, "Segoe UI", sans-serif';
const SEL = "#8cc8ff";

/** NDP.view-style flag: pole foot at (x, y), the flag waving off the top of the pole */
export function drawFlag(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, size = PIN_SIZE, selected = false) {
  const top = y - size * 1.05;
  const w = size * 0.62, h = size * 0.42;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (selected) {
    ctx.beginPath();
    ctx.ellipse(x + w * 0.45, top + h * 0.5, w * 0.75 + 3, h * 0.75 + 3, 0, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = SEL;
    ctx.stroke();
  }
  // pole
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, top);
  ctx.lineWidth = 2.6;
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.stroke();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "#3a3a3a";
  ctx.stroke();
  // cloth, with a slight wave
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.quadraticCurveTo(x + w * 0.5, top - h * 0.18, x + w, top + h * 0.08);
  ctx.lineTo(x + w, top + h * 0.92);
  ctx.quadraticCurveTo(x + w * 0.5, top + h * 0.82, x, top + h);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.restore();
}

/** a pin in its NDP.view icon style */
export function drawPinStyled(ctx: CanvasRenderingContext2D, style: PinStyle | undefined, x: number, y: number, color: string, size = PIN_SIZE, selected = false) {
  if (style === "flag") drawFlag(ctx, x, y, color, size, selected);
  else drawPin(ctx, x, y, color, size, selected);
}

/** NDP.view-style push-pin, needle tip at (x, y) */
export function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, size = PIN_SIZE, selected = false) {
  const { x: hx, y: hy } = pinHead({ x, y }, size);
  const r = size * 0.34;
  ctx.save();
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(hx - r * 0.5, hy + r * 0.5);
  ctx.lineWidth = 2.6;
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.stroke();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "#3a3a3a";
  ctx.stroke();
  if (selected) {
    ctx.beginPath();
    ctx.arc(hx, hy, r + 4, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = SEL;
    ctx.stroke();
  }
  const g = ctx.createRadialGradient(hx - r * 0.35, hy - r * 0.35, r * 0.1, hx, hy, r);
  g.addColorStop(0, "rgba(255,255,255,0.8)");
  g.addColorStop(0.35, color);
  g.addColorStop(1, color);
  ctx.beginPath();
  ctx.arc(hx, hy, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.restore();
}

/** a text label in a dark pill; (x, y) = left middle */
export function drawLabel(ctx: CanvasRenderingContext2D, x: number, y: number, lines: string[], accent?: string, st?: Partial<AnnotationStyle>) {
  const ls = lines.filter(Boolean);
  if (!ls.length) return;
  ctx.save();
  // a11y(visual): label size and a solid background from Preferences ▸ Accessibility
  const k = st?.labelScale ?? 1;
  ctx.font = k === 1 ? FONT : FONT.replace("12px", `${12 * k}px`);
  ctx.textBaseline = "middle";
  const w = Math.max(...ls.map((l) => ctx.measureText(l).width)) + 12 * k;
  const lh = 16 * k;
  const h = ls.length * lh + 4 * k;
  const top = y - h / 2;
  ctx.fillStyle = st?.solidLabels ? "#000" : "rgba(14,14,16,0.72)";
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, top, w, h, 6);
  else ctx.rect(x, top, w, h);
  ctx.fill();
  if (st?.solidLabels) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.stroke();
  }
  if (accent) {
    ctx.fillStyle = accent;
    ctx.fillRect(x, top + 4, 2, h - 8);
  }
  ls.forEach((l, i) => {
    ctx.fillStyle = i === 0 ? "rgba(255,255,255,0.95)" : "rgba(240,240,248,0.75)";
    ctx.fillText(l, x + 7 * k, top + 2 * k + lh * i + lh / 2);
  });
  ctx.restore();
}

function strokeTwice(ctx: CanvasRenderingContext2D, color: string, width: number, halo = false) {
  if (halo) {
    // a11y(visual): a white outer edge, so the outline stands off the stain whatever its colour
    ctx.lineWidth = width + 6;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.stroke();
  }
  ctx.lineWidth = width + 2.5;
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

/** a11y(visual): a white ring under a pin's head (or a flag's cloth) and needle, for the colour-blind-safe display */
function drawPinHalo(ctx: CanvasRenderingContext2D, style: PinStyle | undefined, x: number, y: number, size: number) {
  const h = pinHead({ x, y }, size, style);
  ctx.save();
  ctx.beginPath();
  ctx.arc(h.x, h.y, size * (style === "flag" ? 0.48 : 0.34) + 3, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#000";
  ctx.stroke();
  ctx.restore();
}

function tracePath(ctx: CanvasRenderingContext2D, s: Pt[], closed: boolean) {
  ctx.beginPath();
  s.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  if (closed) ctx.closePath();
}

/** where a shape's label goes (screen) */
function labelAt(coords: ViewerCoords, a: Annotation, s: Pt[], ps = PIN_SIZE): Pt {
  if (a.kind === "pin") {
    const h = pinHead(s[0], ps, a.pinStyle);
    return { x: h.x + ps * (a.pinStyle === "flag" ? 0.4 : 0.45), y: h.y };
  }
  if (a.kind === "circle") {
    const r = (a.radiusNm ?? 0) * coords.screenPxPerNm();
    return { x: s[0].x + r * 0.71 + 6, y: s[0].y - r * 0.71 };
  }
  if (a.kind === "ruler" && s.length >= 2) {
    const m = { x: (s[0].x + s[s.length - 1].x) / 2, y: (s[0].y + s[s.length - 1].y) / 2 };
    return { x: m.x + 10, y: m.y - 12 };
  }
  // rightmost point of the outline
  let best = s[0];
  for (const p of s) if (p.x > best.x) best = p;
  return { x: best.x + 8, y: best.y };
}

export function paintAnnotations(ctx: CanvasRenderingContext2D, coords: ViewerCoords, list: readonly Annotation[], opts: PaintOptions = {}): void {
  const scale = opts.scale ?? 1;
  const hidden = opts.hidden ?? new Set(useAnnUi.getState().hidden);
  const sel = opts.selection ?? new Set<string>();
  const showTitles = opts.showTitles ?? true;
  const calibrated = opts.calibrated ?? useStore.getState().slide.info?.calibrated ?? true;
  const pxPerNm = coords.screenPxPerNm();
  const ax = annotationStyle(); // a11y(visual)
  const ps = PIN_SIZE * ax.pinScale;
  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const labels: (() => void)[] = [];
  for (const a of list) {
    if (hidden.has(a.id) || !a.points.length) continue;
    const s = a.points.map((p) => coords.nmToScreen(p));
    const selected = sel.has(a.id);
    const color = a.color || "#00ff00";
    if (a.kind === "pin") {
      if (ax.halo) drawPinHalo(ctx, a.pinStyle, s[0].x, s[0].y, ps);
      drawPinStyled(ctx, a.pinStyle, s[0].x, s[0].y, color, ps, selected);
    } else if (a.kind === "circle") {
      ctx.beginPath();
      ctx.arc(s[0].x, s[0].y, Math.max(0.5, (a.radiusNm ?? 0) * pxPerNm), 0, Math.PI * 2);
      if (selected) {
        ctx.fillStyle = `${color}22`;
        ctx.fill();
      }
      strokeTwice(ctx, selected ? SEL : color, 2, ax.halo);
    } else if (s.length === 1) {
      ctx.beginPath();
      ctx.arc(s[0].x, s[0].y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      const closed = a.kind === "rectangle" || (a.kind !== "ruler" && a.closed !== false && a.kind !== "other");
      tracePath(ctx, s, closed);
      if (selected && closed) {
        ctx.fillStyle = `${color}22`;
        ctx.fill();
      }
      strokeTwice(ctx, selected ? SEL : color, 2, ax.halo);
      if (a.kind === "ruler") {
        // end ticks, perpendicular to the ruler
        const [p, q] = [s[0], s[s.length - 1]];
        const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
        const nx = ((q.y - p.y) / len) * 6, ny = (-(q.x - p.x) / len) * 6;
        ctx.beginPath();
        for (const e of [p, q]) {
          ctx.moveTo(e.x - nx, e.y - ny);
          ctx.lineTo(e.x + nx, e.y + ny);
        }
        strokeTwice(ctx, selected ? SEL : color, 2, ax.halo);
      }
    }
    if (selected)
      for (const { p } of handlesOf(coords, a)) {
        ctx.beginPath();
        ctx.rect(p.x - 4, p.y - 4, 8, 8);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = INK;
        ctx.stroke();
      }
    const title = showTitles && opts.editingId !== a.id ? a.title : "";
    const m = measureText(a, calibrated);
    const cn = ax.colorNames ? colorName(color) : ""; // a11y(visual): say the colour, not only show it
    if (title || m || cn) {
      const at = labelAt(coords, a, s, ps);
      const rest = [m, cn].filter(Boolean).join(" · ");
      labels.push(() => drawLabel(ctx, at.x, at.y, title ? [title, rest] : [rest], selected ? SEL : color, ax));
    }
  }
  for (const l of labels) l();
  ctx.restore();
}

export { anchorOf };
