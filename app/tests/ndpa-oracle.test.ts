// Adversarial, independent checks of .ndpa writing (verification pass).
//
// The oracles here do NOT reuse the app's serializer or DOM helpers:
//  - well-formedness: the system `xmllint` (libxml2) when it's installed, plus jsdom's strict XML parser;
//  - preservation: the original file's bytes up to its last </ndpviewstate> must reappear unchanged;
//  - element names / order: taken at run time from a real NDP.view2 export that has every shape
//    (test-data/VMS104-shapes.ndpi.ndpa, written by NDP.view2 itself), not from the app's tables;
//  - MSG compatibility: the app's Part-1 `parseNdpa`, after checking its source is still textually
//    identical to Micro Speed Grader's current ndpa.ts (when that repo is on this machine);
//  - coordinates: the NDPI's own TIFF tags / OpenSlide properties for VMS104.ndpi.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { JSDOM } from "jsdom";
import { dataDir, eq, ok, test } from "./harness";
import { loadNdpa, parseNdpa, serializeNdpa } from "../src/lib/ndpa";
import { makeAnnotation } from "../src/lib/annotations";
import { imageToNm, nmToImage } from "../src/lib/coords";
import type { Annotation, AnnotationKind, PtNm } from "../src/lib/types";

(globalThis as { XMLSerializer?: unknown }).XMLSerializer ??= new JSDOM("").window.XMLSerializer;

const MSG_NDPA = "/Users/alexandergadin/vscode/micro-speed-grader/app/src/lib/ndpa.ts";
const MSG_IMAGES = "/Users/alexandergadin/vscode/micro-speed-grader/images";
const ndpaFiles = () => (fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter((f) => f.endsWith(".ndpa")).sort() : []);

// ---------------------------------------------------------------- independent XML helpers

let xmllint: boolean | null = null;
/** null = well formed; otherwise the parser's complaint */
function wellFormed(xml: string): string | null {
  if (xmllint === null) {
    try {
      execFileSync("xmllint", ["--version"], { stdio: "ignore" });
      xmllint = true;
    } catch {
      xmllint = false;
    }
  }
  if (xmllint) {
    try {
      execFileSync("xmllint", ["--noout", "-"], { input: xml, stdio: ["pipe", "ignore", "pipe"] });
    } catch (e) {
      return `xmllint: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)}`;
    }
  }
  if (dom(xml).getElementsByTagName("parsererror").length) return "jsdom: parsererror";
  return null;
}
const dom = (xml: string) => new (new JSDOM("").window.DOMParser)().parseFromString(xml, "application/xml");
const elKids = (e: Element) => Array.from(e.children);
const t = (e: Element | undefined | null) => (e?.textContent ?? "").trim();

/** element skeleton: tag, sorted attribute names (+ type/displayname values), children skeletons (runs of
 *  identical siblings such as <point> and NDP.view2's doubled <specialtype> collapse to one) */
function skeleton(e: Element): string {
  const attrs = Array.from(e.attributes)
    .map((a) => (a.name === "type" || a.name === "displayname" ? `${a.name}=${a.value}` : a.name))
    .sort()
    .join(",");
  const ch: string[] = [];
  for (const c of elKids(e)) {
    const s = skeleton(c);
    if (ch[ch.length - 1] !== s) ch.push(s);
  }
  return `${e.tagName}[${attrs}](${ch.join(" ")})`;
}

/** my own reader of one annotation's geometry */
function geom(ann: Element): { pts: PtNm[]; r?: number } {
  const c = (n: string) => elKids(ann).find((k) => k.tagName === n);
  if (c("x1")) return { pts: [{ x: +t(c("x1")), y: +t(c("y1")) }, { x: +t(c("x2")), y: +t(c("y2")) }] };
  const pl = c("pointlist");
  if (pl) return { pts: elKids(pl).map((p) => ({ x: +t(elKids(p).find((k) => k.tagName === "x")), y: +t(elKids(p).find((k) => k.tagName === "y")) })) };
  return { pts: [{ x: +t(c("x")), y: +t(c("y")) }], r: c("radius") ? +t(c("radius")) : undefined };
}

// ---------------------------------------------------------------- the shapes added to every file

const NEW: { kind: AnnotationKind; display: string; pts: PtNm[]; radiusNm?: number; closed?: boolean; title: string }[] = [
  { kind: "pin", display: "AnnotatePin", pts: [{ x: 4602860.4, y: -257548.6 }], title: "Q7 oracle pin" },
  { kind: "ruler", display: "AnnotateRuler", pts: [{ x: 4944917, y: -1137096 }, { x: 5283609, y: -1137000 }], title: "oracle ruler" },
  { kind: "freehand", display: "AnnotateFreehand", pts: [{ x: 1, y: 2 }, { x: 300, y: 2 }, { x: 300, y: 500 }], closed: true, title: "oracle area" },
  { kind: "freehand", display: "AnnotateFreehandLine", pts: [{ x: -10, y: -20 }, { x: 40, y: 60 }, { x: 90, y: -5 }], closed: false, title: "oracle line" },
  { kind: "circle", display: "AnnotateCircle", pts: [{ x: 4592422, y: -904546 }], radiusNm: 67802, title: "oracle circle" },
  { kind: "rectangle", display: "AnnotateRectangle", pts: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 800 }, { x: 0, y: 800 }], title: "oracle rect & <x> \"q\"" },
];

function addAll(items: Annotation[], doc: unknown): Annotation[] {
  const out = [...items];
  for (const n of NEW) out.push(makeAnnotation(n.kind, n.pts, { color: "#00ff00", items: out, doc, title: n.title, radiusNm: n.radiusNm, closed: n.closed, lens: 20 }));
  return out;
}

/** the real NDP.view2 file with every shape: displayname → skeleton of its annotation / viewstate */
function realSkeletons(): Map<string, { ann: string; vs: string }> | null {
  const f = path.join(dataDir, "VMS104-shapes.ndpi.ndpa");
  if (!fs.existsSync(f)) return null;
  const m = new Map<string, { ann: string; vs: string }>();
  const d = dom(fs.readFileSync(f, "utf8"));
  for (const vs of Array.from(d.getElementsByTagName("ndpviewstate"))) {
    const ann = vs.getElementsByTagName("annotation")[0];
    m.set(ann.getAttribute("displayname")!, { ann: skeleton(ann), vs: skeleton(vs).replace(/annotation\[[^\]]*\]\(.*\)\)$/, "ANN)") });
  }
  // a pin from another real export
  for (const f2 of ndpaFiles()) {
    const d2 = dom(fs.readFileSync(path.join(dataDir, f2), "utf8"));
    const pin = Array.from(d2.getElementsByTagName("annotation")).find((a) => a.getAttribute("type") === "pin");
    if (pin && !m.has("AnnotatePin")) m.set("AnnotatePin", { ann: skeleton(pin), vs: skeleton(pin.parentElement!).replace(/annotation\[[^\]]*\]\(.*\)\)$/, "ANN)") });
  }
  return m;
}

// ---------------------------------------------------------------- tests

test("oracle: MSG's parseNdpa is still the app's Part-1 reader, verbatim", () => {
  if (!fs.existsSync(MSG_NDPA)) return ok(true, "MSG not on this machine (skipped)");
  const own = fs.readFileSync(path.resolve("src/lib/ndpa.ts"), "utf8");
  const msg = fs.readFileSync(MSG_NDPA, "utf8");
  const cut = (s: string) => s.slice(s.indexOf("export interface RawAnnotation"), s.indexOf('/** "VMS146'));
  ok(cut(msg).length > 500 && cut(own) === cut(msg), "parseNdpa and its helpers match MSG's current source");
});

test("oracle: every test file saves back unchanged with no edits", () => {
  const files = ndpaFiles();
  if (!files.length) return ok(true, "no test-data (skipped)");
  for (const f of files) {
    const orig = fs.readFileSync(path.join(dataDir, f), "utf8");
    const { doc, items } = loadNdpa(orig);
    const out = serializeNdpa(doc, items);
    ok(out === orig, `${f}: no-edit save is byte-identical`);
  }
});

test("oracle: one of each shape added to every test file", () => {
  const files = ndpaFiles();
  if (!files.length) return ok(true, "no test-data (skipped)");
  const real = realSkeletons();
  for (const f of files) {
    const orig = fs.readFileSync(path.join(dataDir, f), "utf8");
    const { doc, items } = loadNdpa(orig);
    const all = addAll(items, doc);
    const out = serializeNdpa(doc, all);
    const bad = wellFormed(out);
    ok(!bad, `${f}: well formed${bad ? ` (${bad})` : ""}`);
    if (bad) continue;
    // byte preservation of everything that was there
    const keep = orig.lastIndexOf("</ndpviewstate>") + "</ndpviewstate>".length;
    ok(out.slice(0, keep) === orig.slice(0, keep), `${f}: original viewstates are byte-identical`);
    ok(out.endsWith(orig.slice(orig.lastIndexOf("</annotations>"))), `${f}: root close and trailing text kept`);
    const d = dom(out);
    const vss = Array.from(d.getElementsByTagName("ndpviewstate"));
    const before = dom(orig).getElementsByTagName("ndpviewstate").length;
    eq(vss.length, before + NEW.length, `${f}: ${NEW.length} viewstates appended`);
    const ids = vss.map((v) => v.getAttribute("id"));
    ok(ids.every((i) => /^\d+$/.test(i ?? "")), `${f}: ids are integers`);
    ok(new Set(ids).size === ids.length, `${f}: ids unique`);
    const nums = ids.map(Number);
    ok(nums.slice(before).every((n) => n > Math.max(0, ...nums.slice(0, before))), `${f}: new ids above every old id`);
    ok(nums.slice(before).every((n, i, a) => !i || n > a[i - 1]), `${f}: new ids increase`);
    // the new ones, read with my own reader
    vss.slice(before).forEach((vs, i) => {
      const n = NEW[i];
      const ann = vs.getElementsByTagName("annotation")[0];
      eq(t(elKids(vs).find((k) => k.tagName === "title")), n.title, `${f}: ${n.display} title survives escaping`);
      eq(ann.getAttribute("displayname"), n.display, `${f}: ${n.kind} displayname`);
      eq(t(elKids(vs).find((k) => k.tagName === "coordformat")), "nanometers", `${f}: ${n.display} coordformat`);
      const g = geom(ann);
      eq(g.pts, n.pts.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })), `${f}: ${n.display} coordinates (whole nm)`);
      if (n.radiusNm) eq(g.r, n.radiusNm, `${f}: circle radius`);
      if (real?.has(n.display)) {
        eq(skeleton(ann), real.get(n.display)!.ann, `${f}: ${n.display} element names/order match NDP.view2's own`);
        eq(skeleton(vs).replace(/annotation\[[^\]]*\]\(.*\)\)$/, "ANN)"), real.get(n.display)!.vs, `${f}: ${n.display} viewstate layout matches NDP.view2's own`);
      }
    });
    // MSG reads it: every old annotation it read before, plus the new pointlist/point shapes
    const msgBefore = parseNdpa(orig);
    const msgAfter = parseNdpa(out);
    eq(msgAfter.slice(0, msgBefore.length), msgBefore, `${f}: MSG reads the old annotations the same`);
    const visible = NEW.filter((n) => n.kind !== "ruler"); // MSG skips x1..y2 geometry
    eq(msgAfter.slice(msgBefore.length).map((r) => r.title), visible.map((n) => n.title), `${f}: MSG sees the new shapes' titles`);
    const pin = msgAfter[msgBefore.length];
    eq([pin.xNm, pin.yNm], [4602860, -257549], `${f}: MSG reads the new pin's nm coordinates`);
    // and the app reads its own output back to the same model
    const re = loadNdpa(out);
    eq(re.items.length, all.length, `${f}: reload has every item`);
    eq(
      re.items.slice(items.length).map((a) => [a.kind, a.title, a.points, a.radiusNm ?? null, a.closed ?? null]),
      all.slice(items.length).map((a) => [a.kind, a.title, a.points, a.radiusNm ?? null, a.closed ?? null]),
      `${f}: reload gives the same new shapes`,
    );
    ok(serializeNdpa(re.doc, re.items) === out, `${f}: second no-edit save is byte-identical`);
  }
});

test("oracle: hostile titles never produce an unreadable file", () => {
  const titles = ["a & b < c > d", "]]> end", "tab\there", "ctl \u0001\u0008\u000b\u000c\u001f x", "bad ￾￿ x", "lone \ud800 surrogate", "emoji 🔬 é ü 中文", "  spaced  "];
  let items: Annotation[] = [];
  for (const title of titles) items = [...items, makeAnnotation("pin", [{ x: 1, y: 2 }], { color: "#00ff00", items, title })];
  const out = serializeNdpa(null, items);
  const bad = wellFormed(out);
  ok(!bad, `file with hostile titles is well formed${bad ? ` (${bad})` : ""}`);
  if (bad) return;
  const back = loadNdpa(out).items.map((a) => a.title);
  eq(back[0], "a & b < c > d", "markup characters round-trip");
  eq(back[1], "]]> end", "]]> round-trips");
  eq(back[6], "emoji 🔬 é ü 中文", "non-ASCII round-trips");
  ok(back[3] === "ctl  x" && back[4] === "bad  x" && back[5] === "lone  surrogate", `characters XML can't hold are dropped (${JSON.stringify(back.slice(3, 6))})`);
  // and an edit on a loaded file (setChildText path) too
  const { doc, items: loaded } = loadNdpa(out);
  const edited = serializeNdpa(doc, loaded.map((a, i) => (i === 0 ? { ...a, title: "x\u0002y", details: "d\u0003" } : a)));
  ok(!wellFormed(edited), "renaming to a control character keeps the file well formed");
});

// ---------------------------------------------------------------- coordinates on a real NDPI

/** VMS104.ndpi as OpenSlide reports it (openslide-show-properties, 2026-11-20) */
const VMS104 = { width: 43648, height: 22016, mppX: 0.23101090371465532, mppY: 0.23100023100023101, xOffsetNm: 4463083, yOffsetNm: -607981 };

test("oracle: nm <-> image px on VMS104.ndpi", () => {
  const slide = path.join(MSG_IMAGES, "VMS104.ndpi");
  let live = VMS104;
  try {
    const props = execFileSync("openslide-show-properties", [slide], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const p = (k: string) => Number(props.match(new RegExp(`^${k.replace(/[.[\]]/g, "\\$&")}: '([^']*)'`, "m"))?.[1]);
    live = {
      width: p("openslide.level[0].width"),
      height: p("openslide.level[0].height"),
      mppX: p("openslide.mpp-x"),
      mppY: p("openslide.mpp-y"),
      xOffsetNm: p("hamamatsu.XOffsetFromSlideCentre"),
      yOffsetNm: p("hamamatsu.YOffsetFromSlideCentre"),
    };
    eq(live, VMS104, "OpenSlide still reports the recorded VMS104 geometry");
  } catch {
    ok(true, "OpenSlide CLI or the slide is not here: using the recorded values");
  }
  const i = VMS104;
  // the image centre is the Hamamatsu offset, by definition of XOffsetFromSlideCentre
  eq(imageToNm(i, { x: i.width / 2, y: i.height / 2 }), { x: i.xOffsetNm, y: i.yOffsetNm }, "image centre → the slide-centre offsets");
  // one pixel right / down is mpp*1000 nm (x and y have their own mpp)
  const a = imageToNm(i, { x: 1000, y: 1000 }), b = imageToNm(i, { x: 1001, y: 1001 });
  ok(Math.abs(b.x - a.x - i.mppX * 1000) < 1e-6 && Math.abs(b.y - a.y - i.mppY * 1000) < 1e-6, "1 px = mpp·1000 nm on each axis");
  // corners, explicitly
  const tl = imageToNm(i, { x: 0, y: 0 });
  ok(Math.abs(tl.x - (i.xOffsetNm - (i.width / 2) * i.mppX * 1000)) < 1e-6 && Math.abs(tl.y - (i.yOffsetNm - (i.height / 2) * i.mppY * 1000)) < 1e-6, "top-left corner");
  // round trip through whole-nm rounding stays within half a nm
  for (const p of [{ x: 0, y: 0 }, { x: 12345.6, y: 789.1 }, { x: i.width, y: i.height }]) {
    const nm = imageToNm(i, p);
    const back = nmToImage(i, { x: Math.round(nm.x), y: Math.round(nm.y) });
    ok(Math.abs(back.x - p.x) < 0.01 && Math.abs(back.y - p.y) < 0.01, `round trip (${p.x}, ${p.y}) within 0.01 px`);
  }
  // every annotation NDP.view2 itself saved for VMS104 lands inside the scanned image
  for (const f of ["VMS104.ndpi.ndpa", "VMS104-shapes.ndpi.ndpa"]) {
    const fp = path.join(dataDir, f);
    if (!fs.existsSync(fp)) continue;
    for (const a of loadNdpa(fs.readFileSync(fp, "utf8")).items) {
      const inside = a.points.every((p) => {
        const q = nmToImage(i, p);
        return q.x >= 0 && q.y >= 0 && q.x <= i.width && q.y <= i.height;
      });
      ok(inside, `${f} "${a.title}" maps inside the 43648×22016 image`);
    }
  }
});
