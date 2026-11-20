/**
 * Hamamatsu NDP.view annotation files (.ndpa). Owner: annotations (CONTRACTS.md).
 *
 * Part 1 (`parseNdpa`, `matchTitle`, …) is Micro Speed Grader's reader, copied unchanged: files this app
 * writes must parse with it into the same titles and coordinates.
 * Part 2 (below) is Slide Viewer's DOM-preserving document model: `loadNdpa` reads a file into editable
 * `Annotation`s plus an opaque `NdpaDocument`; `serializeNdpa(doc, items)` writes the ORIGINAL file back with
 * only the edited fields changed, deleted annotations removed and new ones appended as fresh `ndpviewstate`s
 * (NDP.view's formatting: tabs, XML declaration). Unknown elements/attributes and their order survive.
 */
import type { Annotation, AnnotationKind, PtNm } from "./types";
import { uid } from "./util";

export interface RawAnnotation {
  title: string;
  details: string;
  type: string;
  xNm: number;
  yNm: number;
}

const text = (el: Element | null | undefined) => (el?.textContent ?? "").trim();

/** Limits on student-supplied annotation files (real submissions have a handful of pins). */
export const MAX_ANNOTATIONS = 200;
const MAX_TITLE = 300;

const childNamed = (el: Element, tag: string) => Array.from(el.children).find((c) => c.tagName === tag) ?? el.getElementsByTagName(tag)[0];
function nearestViewstate(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === "ndpviewstate") return p;
  return null;
}

export function parseNdpa(xml: string): RawAnnotation[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid annotation XML");
  const out: RawAnnotation[] = [];
  for (const vs of Array.from(doc.getElementsByTagName("ndpviewstate"))) {
    const title = text(childNamed(vs, "title")).slice(0, MAX_TITLE);
    const details = text(childNamed(vs, "details")).slice(0, MAX_TITLE);
    // only annotations whose nearest viewstate is this one: nested viewstates must not count them twice
    const own = Array.from(vs.getElementsByTagName("annotation")).filter((a) => nearestViewstate(a) === vs);
    for (const ann of own) {
      if (out.length >= MAX_ANNOTATIONS) return out;
      const type = ann.getAttribute("type") ?? "pin";
      let x: number, y: number;
      const direct = Array.from(ann.children);
      const dx = direct.find((c) => c.tagName === "x");
      const dy = direct.find((c) => c.tagName === "y");
      if (dx && dy) {
        x = Number(text(dx));
        y = Number(text(dy));
      } else {
        // shapes (circle/freehand): use centroid of the point list, or the centre tag
        const pts = Array.from(ann.getElementsByTagName("point")).map((p) => [
          Number(text(p.getElementsByTagName("x")[0])),
          Number(text(p.getElementsByTagName("y")[0])),
        ]);
        if (!pts.length) continue;
        x = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        y = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      out.push({ title, details, type, xNm: x, yNm: y });
    }
  }
  return out;
}

/** "VMS146.ndpi.ndpa" -> "VMS146" */
export function slideIdFromFilename(name: string): string | null {
  const m = name.match(/(VMS\d+)/i);
  if (m) return m[1].toUpperCase();
  const base = name.replace(/\.ndpa$/i, "").replace(/\.(ndpi|svs|tiff?|mrxs|scn)$/i, "");
  return base || null;
}

/**
 * Read a question number out of a free-text pin title.
 * Returns the number if it is a valid question for this slide; otherwise null.
 */
export function matchTitle(title: string, slideQuestions: number[], bareNumbers = true): { q: number | null; clean: boolean } {
  // titles are student-written: cap the length so matching stays cheap
  const t = title.trim().slice(0, MAX_TITLE);
  const strict = t.match(/^q\s*(\d+)$/i);
  if (strict && slideQuestions.includes(Number(strict[1]))) return { q: Number(strict[1]), clean: true };
  const qish = t.match(/\bq(?:uestion)?\s*(?:#\s*)?(\d+)/i) ?? t.match(/q(\d+)/i);
  if (qish && slideQuestions.includes(Number(qish[1]))) return { q: Number(qish[1]), clean: false };
  if (!bareNumbers) return { q: null, clean: false };
  const nums = (t.match(/\d+/g) ?? []).map(Number).filter((n) => slideQuestions.includes(n));
  if (nums.length === 1) return { q: nums[0], clean: false };
  return { q: null, clean: false };
}

/** The question number a pin's title names ("Q9", "question 9", "q#9"), whether or not it's on the slide. */
export function namedQuestion(title: string): number | null {
  const m = title.trim().slice(0, MAX_TITLE).match(/\bq(?:uestion)?\s*(?:#\s*)?(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

// =====================================================================================================
// Part 2: Slide Viewer's preserving document model (SPEC "NDPA compatibility")
// =====================================================================================================

/**
 * The parsed file, kept as its original text so every save starts from exactly what was on disk
 * (and so undo snapshots never share a mutable DOM). Opaque to everyone but this module.
 */
export interface NdpaDocument {
  /** original file text ("" = a new file) */
  text: string;
  /** raw text before / after the root element (XML declaration, trailing newlines), written back verbatim */
  prolog: string;
  epilog: string;
  /** "<viewstate index>:<annotation index>" of every annotation node that became an item; other nodes are never touched */
  parsed: string[];
  /** largest ndpviewstate id in the file */
  maxId: number;
}

/** what the item looked like when it was read: only fields that differ from this are written */
type Snapshot = Pick<Annotation, "title" | "details" | "color" | "points" | "radiusNm" | "closed">;
/** `Annotation.source` for an item read from the file */
interface OrigSource {
  kind: "orig";
  vs: number;
  ann: number;
  orig: Snapshot;
}
/** `Annotation.source` for an item created in this app: the view it was made in (for <lens>/<z>) */
interface NewSource {
  kind: "new";
  lens: number | null;
  z: number;
}

export const NDPA_DECL = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>';
/** a document for a slide that has no .ndpa yet (NDP.view's declaration and trailing newlines) */
export const emptyNdpa = (): NdpaDocument => ({ text: "", prolog: `${NDPA_DECL}\n`, epilog: "\n\n", parsed: [], maxId: 0 });

/** `source` for an annotation made in this app (lens = the objective magnification it was made at) */
export const newSource = (lens: number | null, z = 0): NewSource => ({ kind: "new", lens, z });

// ---------------------------------------------------------------- small DOM helpers

const lname = (el: Element) => (el.localName || el.tagName).toLowerCase();
const kids = (el: Element) => Array.from(el.children);
const child = (el: Element, tag: string) => kids(el).find((c) => lname(c) === tag) ?? null;
const numOf = (el: Element | null) => (el && text(el) !== "" ? Number(text(el)) : NaN);
const fin = (...v: number[]) => v.every(Number.isFinite);

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length || !doc.documentElement) throw new Error("Invalid annotation XML");
  return doc;
}

function viewstates(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagName("*")).filter((e) => lname(e) === "ndpviewstate");
}
function ownerViewstate(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (lname(p) === "ndpviewstate") return p;
  return null;
}
/** annotation elements that belong to this viewstate (not to a nested one) */
const ownAnnotations = (vs: Element) =>
  Array.from(vs.getElementsByTagName("*")).filter((e) => lname(e) === "annotation" && ownerViewstate(e) === vs);

/** the whitespace that indents `el` (from the text before it), or tabs by depth */
function indentOf(el: Element): string {
  const prev = el.previousSibling;
  if (prev && prev.nodeType === 3) {
    const t = prev.nodeValue ?? "";
    const i = t.lastIndexOf("\n");
    if (i >= 0 && /^[ \t]*$/.test(t.slice(i + 1))) return t.slice(i + 1);
  }
  let depth = 0;
  for (let p = el.parentElement; p; p = p.parentElement) depth++;
  return "\t".repeat(depth);
}
const childIndent = (parent: Element) => {
  const first = kids(parent)[0];
  return first ? indentOf(first) : `${indentOf(parent)}\t`;
};
const ws = (d: Document, s: string) => d.createTextNode(s);
const isWs = (n: Node | null): n is Text => !!n && n.nodeType === 3 && /^\s*$/.test(n.nodeValue ?? "");

/** append `c` as the last child of `parent`, indented like its siblings */
function appendIndented(parent: Element, c: Element) {
  const d = parent.ownerDocument;
  const ci = childIndent(parent);
  const last = parent.lastChild;
  if (isWs(last) && kids(parent).length) {
    parent.insertBefore(ws(d, `\n${ci}`), last);
    parent.insertBefore(c, last);
  } else {
    if (isWs(last)) parent.removeChild(last);
    parent.appendChild(ws(d, `\n${ci}`));
    parent.appendChild(c);
    parent.appendChild(ws(d, `\n${indentOf(parent)}`));
  }
}
/** insert `c` right after `ref` (or first, when ref is null), indented like its siblings */
function insertAfterIndented(parent: Element, ref: Element | null, c: Element) {
  const d = parent.ownerDocument;
  const first = kids(parent)[0];
  if (!first) return appendIndented(parent, c);
  const ci = childIndent(parent);
  if (!ref) {
    parent.insertBefore(c, first);
    parent.insertBefore(ws(d, `\n${ci}`), first);
    return;
  }
  const w = ws(d, `\n${ci}`);
  parent.insertBefore(w, ref.nextSibling);
  parent.insertBefore(c, w.nextSibling);
}
/** remove `el` and the whitespace that indented it */
function removeIndented(el: Element) {
  const prev = el.previousSibling;
  if (isWs(prev) && (prev.nodeValue ?? "").includes("\n")) prev.parentNode?.removeChild(prev);
  el.parentNode?.removeChild(el);
}

/** [tag, attributes, children or text]: built with NDP.view's tab indentation */
type Spec = [string, Record<string, string>, Spec[] | string];
function build(d: Document, [tag, attrs, body]: Spec, indent: string): Element {
  const el = d.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (typeof body === "string") {
    if (body) el.textContent = body;
  } else {
    for (const c of body) {
      el.appendChild(ws(d, `\n${indent}\t`));
      el.appendChild(build(d, c, `${indent}\t`));
    }
    if (body.length) el.appendChild(ws(d, `\n${indent}`));
  }
  return el;
}

/** NDP.view writes whole nanometres */
export const fmtNm = (v: number) => String(Math.round(v));

// ---------------------------------------------------------------- colours / pin icons

/**
 * NDP.view pin icons are named after their colour ("pingreen" / "iconpingreen"). Pins come in these
 * colours, so a picked colour maps to the nearest one. Only green is confirmed by real files; the other
 * names follow the same pattern (SPEC: check against a real NDP.view file).
 */
export const PIN_COLORS: { name: string; hex: string }[] = [
  { name: "red", hex: "#ff0000" },
  { name: "green", hex: "#00ff00" },
  { name: "blue", hex: "#0000ff" },
  { name: "yellow", hex: "#ffff00" },
  { name: "cyan", hex: "#00ffff" },
  { name: "magenta", hex: "#ff00ff" },
  { name: "white", hex: "#ffffff" },
  { name: "black", hex: "#000000" },
];
const COLOR_WORDS = PIN_COLORS.map((c) => c.name).join("|");

/** "#0f0", "0F0", "#00FF00" → "#00ff00"; null when it isn't a colour */
export function normColor(c: string | null | undefined): string | null {
  const m = (c ?? "").trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
  return `#${h.toLowerCase()}`;
}
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** the NDP.view pin colour nearest to `hex` */
export function nearestPinColor(hex: string): { name: string; hex: string } {
  const c = rgb(normColor(hex) ?? "#00ff00");
  let best = PIN_COLORS[1];
  let bd = Infinity;
  for (const p of PIN_COLORS) {
    const q = rgb(p.hex);
    const dd = (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2;
    if (dd < bd) {
      bd = dd;
      best = p;
    }
  }
  return best;
}
/** "pingreen" for a colour */
export const pinIcon = (hex: string) => `pin${nearestPinColor(hex).name}`;

// ---------------------------------------------------------------- reading

const LINEAR = new Set(["linear", "linearmeasure", "line", "ruler", "arrow"]);
const AREA = new Set(["freehand", "polygon", "rectangle", "polyline"]);

function pointsOf(ann: Element): PtNm[] | null {
  const pl = child(ann, "pointlist") ?? Array.from(ann.getElementsByTagName("*")).find((c) => lname(c) === "pointlist");
  if (!pl) return null;
  const pts = kids(pl)
    .filter((p) => lname(p) === "point")
    .map((p) => ({ x: numOf(child(p, "x")), y: numOf(child(p, "y")) }));
  return pts.every((p) => fin(p.x, p.y)) ? pts : null;
}

/** one annotation element → the app's model (null: geometry we can't read; the node is then left alone) */
function readAnnotation(vs: Element, ann: Element): Omit<Annotation, "id" | "ndpaId" | "source"> | null {
  const ndpType = ann.getAttribute("type") ?? "pin";
  const t = ndpType.toLowerCase();
  const displayName = ann.getAttribute("displayname") ?? undefined;
  const color = normColor(ann.getAttribute("color")) ?? "#00ff00";
  const titleEl = child(vs, "title");
  const detailsEl = child(vs, "details");
  const base = { title: titleEl ? text(titleEl) : "", details: detailsEl ? text(detailsEl) : "", color, ndpType, displayName };
  const x = numOf(child(ann, "x")), y = numOf(child(ann, "y"));
  const pts = pointsOf(ann);
  const special = text(child(ann, "specialtype")).toLowerCase();
  const closedEl = child(ann, "closed");
  let kind: AnnotationKind = "other";
  let points: PtNm[] | null = null;
  let radiusNm: number | undefined;
  let closed: boolean | undefined;
  if (t === "pin") {
    if (fin(x, y)) {
      kind = "pin";
      points = [{ x, y }];
    }
  } else if (t === "circle") {
    const r = numOf(child(ann, "radius"));
    if (fin(x, y, r)) {
      kind = "circle";
      points = [{ x, y }];
      radiusNm = r;
    }
  } else if (LINEAR.has(t)) {
    const x1 = numOf(child(ann, "x1")), y1 = numOf(child(ann, "y1")), x2 = numOf(child(ann, "x2")), y2 = numOf(child(ann, "y2"));
    const ends = fin(x1, y1, x2, y2) ? [{ x: x1, y: y1 }, { x: x2, y: y2 }] : null;
    if (t !== "arrow" && pts && pts.length === 2) {
      kind = "ruler";
      points = pts;
    } else if (t !== "arrow" && !pts && ends) {
      kind = "ruler";
      points = ends;
    } else points = pts?.length ? pts : ends;
  } else if (AREA.has(t)) {
    const isRect = t === "rectangle" || special === "rectangle" || /rectangle/i.test(displayName ?? "");
    if (pts && isRect && pts.length === 4) {
      kind = "rectangle";
      points = pts;
      closed = true;
    } else if (pts && pts.length >= 2) {
      kind = "freehand";
      points = pts;
      closed = closedEl ? text(closedEl) !== "0" : t !== "polyline";
    }
  } else if (pts?.length) points = pts;
  else if (fin(x, y)) points = [{ x, y }];
  if (!points || !points.length) return null;
  return { ...base, kind, points, radiusNm, closed };
}

const snapshot = (a: Snapshot): Snapshot => ({
  title: a.title,
  details: a.details,
  color: a.color,
  points: a.points.map((p) => ({ ...p })),
  radiusNm: a.radiusNm,
  closed: a.closed,
});

/** split the original text around the root element so the declaration and trailing text are kept byte for byte */
function splitProlog(xml: string, rootName: string): { prolog: string; epilog: string } {
  const pm = xml.match(/^﻿?(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/);
  const prolog = pm ? pm[0].replace(/^﻿/, "") : "";
  const close = xml.lastIndexOf(`</${rootName}`);
  let epilog = "";
  if (close >= 0) {
    const gt = xml.indexOf(">", close);
    if (gt >= 0) epilog = xml.slice(gt + 1);
  } else epilog = (xml.match(/\s*$/) ?? [""])[0];
  return { prolog, epilog };
}

/**
 * Read an .ndpa file (any NDP.view2 file; tolerant of variations) into editable annotations plus the
 * preserved document. Throws on XML that doesn't parse.
 */
export function loadNdpa(xml: string): { doc: NdpaDocument; items: Annotation[] } {
  const d = parseXml(xml);
  const { prolog, epilog } = splitProlog(xml, d.documentElement.tagName);
  const items: Annotation[] = [];
  const parsed: string[] = [];
  let maxId = 0;
  viewstates(d).forEach((vs, vi) => {
    const idAttr = Number(vs.getAttribute("id") ?? NaN);
    const ndpaId = Number.isFinite(idAttr) ? idAttr : null;
    if (ndpaId !== null) maxId = Math.max(maxId, ndpaId);
    ownAnnotations(vs).forEach((ann, ai) => {
      const a = readAnnotation(vs, ann);
      if (!a) return;
      parsed.push(`${vi}:${ai}`);
      const source: OrigSource = { kind: "orig", vs: vi, ann: ai, orig: snapshot(a) };
      items.push({ id: `a${uid()}${items.length}`, ndpaId, ...a, source });
    });
  });
  return { doc: { text: xml, prolog, epilog, parsed, maxId }, items };
}

// ---------------------------------------------------------------- writing

const sameNum = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? a === b : Math.round(a) === Math.round(b));
const samePoints = (a: PtNm[], b: PtNm[]) => a.length === b.length && a.every((p, i) => sameNum(p.x, b[i].x) && sameNum(p.y, b[i].y));

/** set `<tag>` under parent (when missing, create it after the `after` sibling, first when after is null, or last) */
function setChildText(parent: Element, tag: string, value: string, after?: string | null) {
  let el = child(parent, tag);
  if (!el) {
    el = parent.ownerDocument.createElement(tag);
    if (after === undefined) appendIndented(parent, el);
    else insertAfterIndented(parent, after === null ? null : child(parent, after), el);
  }
  el.textContent = value;
}

function writePoints(ann: Element, pts: PtNm[]) {
  const d = ann.ownerDocument;
  let pl = child(ann, "pointlist");
  if (!pl) {
    pl = d.createElement("pointlist");
    appendIndented(ann, pl);
  }
  while (pl.firstChild) pl.removeChild(pl.firstChild);
  const ind = indentOf(pl);
  for (const p of pts) {
    pl.appendChild(ws(d, `\n${ind}\t`));
    pl.appendChild(build(d, ["point", {}, [["x", {}, fmtNm(p.x)], ["y", {}, fmtNm(p.y)]]], `${ind}\t`));
  }
  if (pts.length) pl.appendChild(ws(d, `\n${ind}`));
}

function recolorIcon(el: Element | null, hex: string) {
  if (!el) return;
  const t = text(el);
  const re = new RegExp(`(${COLOR_WORDS})$`, "i");
  if (re.test(t)) el.textContent = t.replace(re, nearestPinColor(hex).name);
}

/** write only the fields of `a` that differ from what was read */
function applyEdits(vs: Element, ann: Element, a: Annotation, o: Snapshot) {
  if (a.title !== o.title) setChildText(vs, "title", a.title, null);
  if (a.details !== o.details) setChildText(vs, "details", a.details, "title");
  if (a.color !== o.color) {
    ann.setAttribute("color", a.color);
    if (a.kind === "pin") {
      recolorIcon(child(ann, "icon"), a.color);
      recolorIcon(child(ann, "stricon"), a.color);
    }
  }
  const geom = !samePoints(a.points, o.points) || !sameNum(a.radiusNm, o.radiusNm) || a.closed !== o.closed;
  if (!geom) return;
  switch (a.kind) {
    case "pin":
      setChildText(ann, "x", fmtNm(a.points[0].x));
      setChildText(ann, "y", fmtNm(a.points[0].y));
      break;
    case "circle":
      setChildText(ann, "x", fmtNm(a.points[0].x));
      setChildText(ann, "y", fmtNm(a.points[0].y));
      setChildText(ann, "radius", fmtNm(a.radiusNm ?? 0));
      break;
    case "ruler":
      if (!child(ann, "pointlist") && child(ann, "x1")) {
        setChildText(ann, "x1", fmtNm(a.points[0].x));
        setChildText(ann, "y1", fmtNm(a.points[0].y));
        setChildText(ann, "x2", fmtNm(a.points[1].x));
        setChildText(ann, "y2", fmtNm(a.points[1].y));
      } else writePoints(ann, a.points);
      break;
    case "freehand":
    case "rectangle":
      writePoints(ann, a.points);
      if (a.closed !== o.closed && child(ann, "closed")) setChildText(ann, "closed", a.closed === false ? "0" : "1");
      break;
    default:
      // "other": geometry we don't edit
      break;
  }
}

/** where an annotation is: pin point, circle centre, or the average of its points (what MSG's reader reports) */
export function anchorOf(a: Pick<Annotation, "kind" | "points">): PtNm {
  if (a.kind === "pin" || a.kind === "circle" || a.points.length === 1) return a.points[0];
  return { x: a.points.reduce((s, p) => s + p.x, 0) / a.points.length, y: a.points.reduce((s, p) => s + p.y, 0) / a.points.length };
}

const ptsSpec = (pts: PtNm[]): Spec[] => pts.map((p) => ["point", {}, [["x", {}, fmtNm(p.x)], ["y", {}, fmtNm(p.y)]]]);

function annotationSpec(a: Annotation): Spec {
  const color = a.color;
  const p0 = a.points[0];
  switch (a.kind) {
    case "pin": {
      const icon = pinIcon(color);
      return ["annotation", { type: "pin", displayname: "AnnotatePin", color }, [["x", {}, fmtNm(p0.x)], ["y", {}, fmtNm(p0.y)], ["icon", {}, icon], ["stricon", {}, `icon${icon}`]]];
    }
    case "circle":
      return ["annotation", { type: "circle", displayname: "AnnotateCircle", color }, [["x", {}, fmtNm(p0.x)], ["y", {}, fmtNm(p0.y)], ["radius", {}, fmtNm(a.radiusNm ?? 0)], ["measuretype", {}, "3"]]];
    case "ruler":
      return ["annotation", { type: "linear", displayname: "AnnotateRuler", color }, [["measuretype", {}, "1"], ["pointlist", {}, ptsSpec(a.points)]]];
    case "rectangle":
      return [
        "annotation",
        { type: "freehand", displayname: "AnnotateRectangle", color },
        [["measuretype", {}, "0"], ["closed", {}, "1"], ["pointlist", {}, ptsSpec(a.points)], ["specialtype", {}, "rectangle"]],
      ];
    case "freehand":
      return ["annotation", { type: "freehand", displayname: "AnnotateFreehand", color }, [["measuretype", {}, "0"], ["closed", {}, a.closed === false ? "0" : "1"], ["pointlist", {}, ptsSpec(a.points)]]];
    default:
      return ["annotation", { type: a.ndpType ?? "freehand", displayname: a.displayName ?? "AnnotateFreehand", color }, [["closed", {}, "0"], ["pointlist", {}, ptsSpec(a.points)]]];
  }
}

function viewstateSpec(a: Annotation, id: number): Spec {
  const src = a.source as Partial<NewSource> | undefined;
  const isNew = src?.kind === "new";
  const lens = isNew && src.lens && Number.isFinite(src.lens) ? src.lens : 10;
  const c = anchorOf(a);
  return [
    "ndpviewstate",
    { id: String(id) },
    [
      ["title", {}, a.title],
      ["details", {}, a.details],
      ["coordformat", {}, "nanometers"],
      ["lens", {}, lens.toFixed(6)],
      ["x", {}, fmtNm(c.x)],
      ["y", {}, fmtNm(c.y)],
      ["z", {}, String(Math.round(isNew ? (src.z ?? 0) : 0))],
      ["showtitle", {}, "1"],
      ["showhistogram", {}, "0"],
      ["showlineprofile", {}, "0"],
      annotationSpec(a),
    ],
  ];
}

const isOrig = (s: unknown): s is OrigSource => !!s && typeof s === "object" && (s as OrigSource).kind === "orig";

/** the ndpviewstate id for the next new annotation */
export function nextNdpaId(doc: NdpaDocument | null | undefined, items: readonly Annotation[]): number {
  return Math.max(doc?.maxId ?? 0, 0, ...items.map((a) => a.ndpaId ?? 0)) + 1;
}

/**
 * Write the document back: the original text with the edits applied. Unchanged items leave their nodes
 * byte-identical; deleted ones are removed (an emptied ndpviewstate goes with them); new items are
 * appended as ndpviewstates with fresh increasing ids, formatted like NDP.view's own.
 */
export function serializeNdpa(doc: NdpaDocument | null | undefined, items: readonly Annotation[]): string {
  const base = doc ?? emptyNdpa();
  const d = parseXml(base.text || "<annotations>\n</annotations>");
  const root = d.documentElement;
  const vss = viewstates(d);
  const anns = vss.map(ownAnnotations);
  const parsed = new Set(base.parsed);
  const kept = new Set<string>();
  const fresh: Annotation[] = [];
  for (const a of items) {
    const s = a.source;
    const key = isOrig(s) ? `${s.vs}:${s.ann}` : "";
    const node = isOrig(s) && parsed.has(key) && !kept.has(key) ? anns[s.vs]?.[s.ann] : undefined;
    if (isOrig(s) && node) {
      kept.add(key);
      applyEdits(vss[s.vs], node, a, s.orig);
    } else fresh.push(a);
  }
  // deletions: annotation nodes that were items and no longer are
  const emptied = new Set<Element>();
  for (const key of base.parsed) {
    if (kept.has(key)) continue;
    const [vi, ai] = key.split(":").map(Number);
    const node = anns[vi]?.[ai];
    if (!node) continue;
    removeIndented(node);
    emptied.add(vss[vi]);
  }
  for (const vs of emptied) if (!ownAnnotations(vs).length) removeIndented(vs);
  // new annotations, with ids that are unique and above every id in the file
  const used = new Set(vss.map((v) => Number(v.getAttribute("id") ?? NaN)).filter(Number.isFinite));
  for (const a of fresh) {
    let id = a.ndpaId ?? 0;
    if (!(Number.isInteger(id) && id > base.maxId && !used.has(id))) id = Math.max(base.maxId, ...used, 0) + 1;
    used.add(id);
    appendIndented(root, build(d, viewstateSpec(a, id), childIndent(root)));
  }
  return base.prolog + new XMLSerializer().serializeToString(root) + base.epilog;
}
