// Tests for the annotations feature: the preserving .ndpa model, MSG compatibility, the annotation model,
// hit-testing and autosave path choice. Owner: annotations builder (CONTRACTS.md).
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { dataDir, eq, near, ok, test } from "./harness";
import { anchorOf, emptyNdpa, loadNdpa, nearestPinColor, nextNdpaId, normColor, serializeNdpa, type NdpaDocument } from "../src/lib/ndpa";
import {
  addAnnotation,
  defaultTitle,
  deleteAnnotations,
  duplicateTitles,
  hitTest,
  makeAnnotation,
  measureText,
  moveBy,
  rectFrom,
  updateAnnotation,
  withVertex,
} from "../src/lib/annotations";
import { choosePaths } from "../src/lib/autosave";
import { useStore } from "../src/lib/store";
import type { Annotation } from "../src/lib/types";
import type { ViewerCoords } from "../src/lib/viewerContext";

// the app's serializer is the browser's; under Node use jsdom's
(globalThis as { XMLSerializer?: unknown }).XMLSerializer ??= new JSDOM("").window.XMLSerializer;

// ---------------------------------------------------------------- fixture: Micro Speed Grader's reader, verbatim
// (copied from micro-speed-grader app/src/lib/ndpa.ts, so a change on our side can't hide an incompatibility)
interface MsgRaw {
  title: string;
  details: string;
  type: string;
  xNm: number;
  yNm: number;
}
const msgText = (el: Element | null | undefined) => (el?.textContent ?? "").trim();
const MSG_MAX_ANNOTATIONS = 200;
const MSG_MAX_TITLE = 300;
const childNamed = (el: Element, tag: string) => Array.from(el.children).find((c) => c.tagName === tag) ?? el.getElementsByTagName(tag)[0];
function nearestViewstate(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === "ndpviewstate") return p;
  return null;
}
function msgParseNdpa(xml: string): MsgRaw[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid annotation XML");
  const out: MsgRaw[] = [];
  for (const vs of Array.from(doc.getElementsByTagName("ndpviewstate"))) {
    const title = msgText(childNamed(vs, "title")).slice(0, MSG_MAX_TITLE);
    const details = msgText(childNamed(vs, "details")).slice(0, MSG_MAX_TITLE);
    const own = Array.from(vs.getElementsByTagName("annotation")).filter((a) => nearestViewstate(a) === vs);
    for (const ann of own) {
      if (out.length >= MSG_MAX_ANNOTATIONS) return out;
      const type = ann.getAttribute("type") ?? "pin";
      let x: number, y: number;
      const direct = Array.from(ann.children);
      const dx = direct.find((c) => c.tagName === "x");
      const dy = direct.find((c) => c.tagName === "y");
      if (dx && dy) {
        x = Number(msgText(dx));
        y = Number(msgText(dy));
      } else {
        const pts = Array.from(ann.getElementsByTagName("point")).map((p) => [
          Number(msgText(p.getElementsByTagName("x")[0])),
          Number(msgText(p.getElementsByTagName("y")[0])),
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

// ---------------------------------------------------------------- helpers

/** a canonical form of an XML document: elements, attributes in order, trimmed text; whitespace-only text dropped */
function canon(xml: string): string {
  const d = new DOMParser().parseFromString(xml, "application/xml");
  const walk = (n: Node): string => {
    if (n.nodeType === 3 || n.nodeType === 4) return (n.nodeValue ?? "").trim() ? JSON.stringify((n.nodeValue ?? "").trim()) : "";
    if (n.nodeType === 8) return `<!--${n.nodeValue}-->`;
    if (n.nodeType !== 1) return "";
    const el = n as Element;
    const attrs = Array.from(el.attributes).map((a) => `${a.name}=${JSON.stringify(a.value)}`).join(" ");
    return `<${el.tagName}${attrs ? " " + attrs : ""}>${Array.from(el.childNodes).map(walk).join("")}</${el.tagName}>`;
  };
  return walk(d.documentElement);
}

const files = () => (fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter((f) => f.endsWith(".ndpa")).sort() : []);
const read = (f: string) => fs.readFileSync(path.join(dataDir, f), "utf8");

const SHAPES = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<!-- written by hand: every shape type, plus things we don't model -->
<annotations version="2" xmlns:extra="urn:x">
	<ndpviewstate id="3">
		<title>Pin &amp; friends</title>
		<details/>
		<coordformat>nanometers</coordformat>
		<lens>6.015852</lens>
		<x>100</x>
		<y>200</y>
		<z>0</z>
		<showtitle>1</showtitle>
		<showhistogram>0</showhistogram>
		<showlineprofile>0</showlineprofile>
		<annotation type="pin" displayname="AnnotatePin" color="#00ff00" extra:flag="yes">
			<x>4602860</x>
			<y>-257548</y>
			<icon>pingreen</icon>
			<stricon>iconpingreen</stricon>
			<unknownchild a="1">keep me</unknownchild>
		</annotation>
		<futurefield>survives</futurefield>
	</ndpviewstate>
	<ndpviewstate id="7">
		<title>circle</title>
		<details>round thing</details>
		<annotation type="circle" displayname="AnnotateCircle" color="#FF0000">
			<x>1000</x>
			<y>2000</y>
			<radius>500</radius>
			<measuretype>3</measuretype>
		</annotation>
	</ndpviewstate>
	<ndpviewstate id="8">
		<title>outline</title>
		<details/>
		<annotation type="freehand" displayname="AnnotateFreehand" color="#0000ff">
			<measuretype>0</measuretype>
			<closed>1</closed>
			<pointlist>
				<point>
					<x>0</x>
					<y>0</y>
				</point>
				<point>
					<x>3000</x>
					<y>0</y>
				</point>
				<point>
					<x>3000</x>
					<y>4000</y>
				</point>
			</pointlist>
		</annotation>
	</ndpviewstate>
	<ndpviewstate id="9">
		<title>box</title>
		<details/>
		<annotation type="freehand" displayname="AnnotateRectangle" color="#ffff00">
			<measuretype>0</measuretype>
			<closed>1</closed>
			<pointlist>
				<point><x>0</x><y>0</y></point>
				<point><x>10</x><y>0</y></point>
				<point><x>10</x><y>20</y></point>
				<point><x>0</x><y>20</y></point>
			</pointlist>
			<specialtype>rectangle</specialtype>
		</annotation>
	</ndpviewstate>
	<ndpviewstate id="10">
		<title>ruler</title>
		<details/>
		<annotation type="linear" displayname="AnnotateRuler" color="#00ff00">
			<measuretype>1</measuretype>
			<pointlist>
				<point><x>0</x><y>0</y></point>
				<point><x>30000</x><y>40000</y></point>
			</pointlist>
		</annotation>
	</ndpviewstate>
	<ndpviewstate id="11">
		<title>old ruler</title>
		<annotation type="linearmeasure" color="#00ff00"><x1>0</x1><y1>0</y1><x2>6000</x2><y2>8000</y2></annotation>
	</ndpviewstate>
	<ndpviewstate id="12">
		<title>arrow</title>
		<annotation type="arrow" displayname="AnnotateArrow" color="#ffffff"><pointlist><point><x>5</x><y>5</y></point><point><x>9</x><y>9</y></point></pointlist></annotation>
	</ndpviewstate>
	<ndpviewstate id="13">
		<title>broken</title>
		<annotation type="pin"><x>oops</x><y/></annotation>
	</ndpviewstate>
	<ndpviewstate id="14">
		<title>just a saved view</title>
		<lens>2.5</lens>
	</ndpviewstate>
</annotations>
`;

// ---------------------------------------------------------------- round trips

test("ndpa: every NDP.view2 test file round-trips byte for byte", () => {
  const fs_ = files();
  if (!fs_.length) return ok(true, `no ${dataDir} (skipped)`);
  let same = 0, sem = 0, n = 0;
  for (const f of fs_) {
    const x = read(f);
    const { doc, items } = loadNdpa(x);
    n += items.length;
    const out = serializeNdpa(doc, items);
    if (out === x) same++;
    if (canon(out) === canon(x)) sem++;
    else ok(false, `${f}: semantic diff after round trip`);
  }
  ok(sem === fs_.length, `${sem}/${fs_.length} files semantically identical`);
  ok(same === fs_.length, `${same}/${fs_.length} files byte-identical`);
  ok(n >= fs_.length, `${n} annotations read`);
});

test("ndpa: test files read the same as MSG's reader", () => {
  for (const f of files()) {
    const x = read(f);
    const ours = loadNdpa(x).items;
    const msg = msgParseNdpa(x);
    eq(
      ours.map((a) => [a.title, a.details, a.ndpType, anchorOf(a).x, anchorOf(a).y]),
      msg.map((m) => [m.title, m.details, m.type, m.xNm, m.yNm]),
      `${f}: same titles, details and coordinates`,
    );
    // every <annotation color="…"> comes through as the item's colour (pingreen pins, flagred pins, shapes)
    const colours = [...x.matchAll(/<annotation\b[^>]*\bcolor="([^"]+)"/g)].map((m) => normColor(m[1]));
    eq(ours.map((a) => a.color), colours, `${f}: colours as in the file`);
  }
});

// integration: a real NDP.view2 export with a closed freehand outline and red flag pins (test-data/VMS105-shapes)
test("ndpa: real NDP.view2 file with shapes", () => {
  const f = files().find((p) => p.endsWith("VMS105-shapes.ndpi.ndpa"));
  if (!f) return;
  const x = read(f);
  const { doc, items } = loadNdpa(x);
  eq(items.map((a) => a.kind), ["pin", "pin", "pin", "pin", "pin", "freehand"], "five pins and one outline");
  const fh = items[5];
  ok(fh.closed === true && fh.points.length > 50, `closed freehand with ${fh.points.length} points`);
  eq(fh.color, "#00ff00", "freehand colour");
  ok(items.slice(0, 5).every((a) => a.color === "#ff0000"), "red flag pins");
  // renaming the outline rewrites only its title; the flag icons and point list stay byte for byte
  const out = serializeNdpa(doc, items.map((a, i) => (i === 5 ? { ...a, title: "renamed" } : a)));
  eq(out, x.replace("<title>secretory elements</title>", "<title>renamed</title>"), "rename keeps everything else");
});

test("ndpa: shapes and unknown XML", () => {
  const { doc, items } = loadNdpa(SHAPES);
  eq(items.map((a) => a.kind), ["pin", "circle", "freehand", "rectangle", "ruler", "ruler", "other"], "kinds (the broken pin and the bare view aren't items)");
  eq(items.map((a) => a.ndpaId), [3, 7, 8, 9, 10, 11, 12], "ndpviewstate ids");
  eq(items[0].title, "Pin & friends", "entities decoded");
  eq(items[1].color, "#ff0000", "colour normalised");
  eq(items[1].radiusNm, 500, "circle radius");
  ok(items[2].closed === true && items[2].points.length === 3, "closed freehand");
  eq(items[5].points, [{ x: 0, y: 0 }, { x: 6000, y: 8000 }], "x1/y1/x2/y2 ruler");
  eq(doc.maxId, 14, "max id");
  const out = serializeNdpa(doc, items);
  ok(out === SHAPES, "untouched document is byte-identical (comment, namespaces, unknown children, bare views)");
});

test("ndpa: edits change only the edited fields", () => {
  const { doc, items } = loadNdpa(SHAPES);
  const edited = items.map((a) => {
    if (a.kind === "pin") return { ...a, title: "Q1 <b>", color: "#ff0000", points: [{ x: 11, y: 22 }] };
    if (a.kind === "circle") return { ...a, radiusNm: 750 };
    if (a.kind === "freehand") return withVertex(a, 1, { x: 3100.4, y: 10 });
    if (a.title === "old ruler") return { ...a, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] };
    if (a.kind === "other") return { ...a, details: "new note" };
    return a;
  });
  const out = serializeNdpa(doc, edited);
  ok(out.includes("<title>Q1 &lt;b&gt;</title>"), "title escaped");
  ok(out.includes('color="#ff0000" extra:flag="yes"'), "colour changed, other attributes kept in order");
  ok(out.includes("<icon>pinred</icon>") && out.includes("<stricon>iconpinred</stricon>"), "pin icon follows the colour");
  ok(out.includes("<x>11</x>") && out.includes("<y>22</y>"), "pin moved");
  ok(out.includes('<unknownchild a="1">keep me</unknownchild>') && out.includes("<futurefield>survives</futurefield>"), "unknown elements kept");
  ok(out.includes("<radius>750</radius>"), "radius");
  ok(out.includes("\t\t\t\t<point>\n\t\t\t\t\t<x>3100</x>\n\t\t\t\t\t<y>10</y>\n\t\t\t\t</point>"), "vertex written, rounded, tab-indented");
  ok(out.includes("<x1>1</x1><y1>2</y1><x2>3</x2><y2>4</y2>"), "x1..y2 ruler edited in place");
  ok(out.includes("<title>arrow</title>\n\t\t<details>new note</details>"), "missing details inserted after the title");
  ok(out.includes("<title>broken</title>") && out.includes("<x>oops</x>"), "unreadable annotation left alone");
  ok(out.startsWith('<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<!-- written by hand'), "prolog kept");
  const again = loadNdpa(out).items;
  eq(again.map((a) => a.title)[0], "Q1 <b>", "re-read title");
  eq(again.find((a) => a.kind === "circle")?.radiusNm, 750, "re-read radius");
  const msg = msgParseNdpa(out);
  eq(msg[0].title, "Q1 <b>", "MSG reads the new title");
  eq([msg[0].xNm, msg[0].yNm], [11, 22], "MSG reads the moved pin");
});

test("ndpa: delete removes nodes, keeps the rest", () => {
  const { doc, items } = loadNdpa(SHAPES);
  const out = serializeNdpa(doc, items.filter((a) => a.kind !== "circle" && a.kind !== "other"));
  ok(!out.includes('id="7"') && !out.includes('id="12"'), "deleted viewstates gone");
  ok(out.includes('id="13"') && out.includes('id="14"'), "untouched viewstates kept");
  ok(!/\n\t\n/.test(out) && !/\n\n\t/.test(out), "no blank lines left behind");
  eq(canon(out), canon(SHAPES.replace(/\t<ndpviewstate id="7">[\s\S]*?<\/ndpviewstate>\n/, "").replace(/\t<ndpviewstate id="12">[\s\S]*?<\/ndpviewstate>\n/, "")), "only those two removed");
  const none = serializeNdpa(doc, []);
  ok(msgParseNdpa(none).length === 0 && none.includes("just a saved view"), "deleting everything keeps unknown views");
});

test("ndpa: new annotations are NDP.view-formatted and MSG-compatible", () => {
  const base = files()[0] ? loadNdpa(read(files()[0])) : { doc: emptyNdpa(), items: [] as Annotation[] };
  let items = [...base.items];
  const add = (a: Annotation) => (items = [...items, a]);
  const mk = (kind: Annotation["kind"], pts: { x: number; y: number }[], o: Partial<Parameters<typeof makeAnnotation>[2]> = {}) =>
    makeAnnotation(kind, pts, { color: "#00ff00", items, doc: base.doc, lens: 12.5, ...o });
  add(mk("pin", [{ x: 1234.4, y: -5678.6 }], { title: "Q7" }));
  add(mk("ruler", [{ x: 0, y: 0 }, { x: 3000, y: 4000 }]));
  add(mk("freehand", [{ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 300 }], { title: "Question 3" }));
  add(mk("circle", [{ x: 50, y: 60 }], { radiusNm: 70 }));
  add(mk("rectangle", rectFrom({ x: 10, y: 10 }, { x: 110, y: 60 }), { color: "#ff00ff" }));
  const ids = items.map((a) => a.ndpaId!);
  ok(new Set(ids).size === ids.length && ids.slice(base.items.length).every((id, i, a) => id > base.doc.maxId && (!i || id > a[i - 1])), "fresh increasing ids");
  const out = serializeNdpa(base.doc, items);
  ok(out.startsWith('<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<annotations>\n\t<ndpviewstate id="'), "declaration + tab indentation");
  ok(out.endsWith("</annotations>\n\n"), "NDP.view's trailing newlines");
  ok(out.includes('\t<ndpviewstate id="' + items[base.items.length].ndpaId + '">\n\t\t<title>Q7</title>\n\t\t<details/>\n\t\t<coordformat>nanometers</coordformat>\n\t\t<lens>12.500000</lens>'), "new pin's viewstate header");
  ok(out.includes('<annotation type="pin" displayname="AnnotatePin" color="#00ff00">\n\t\t\t<x>1234</x>\n\t\t\t<y>-5679</y>\n\t\t\t<icon>pingreen</icon>\n\t\t\t<stricon>iconpingreen</stricon>\n\t\t</annotation>'), "pin body like NDP.view's");
  ok(out.includes('type="linear" displayname="AnnotateRuler"') && out.includes("<measuretype>1</measuretype>"), "ruler as a linear annotation");
  ok(out.includes('type="circle" displayname="AnnotateCircle"') && out.includes("<radius>70</radius>"), "circle");
  ok(out.includes('displayname="AnnotateRectangle" color="#ff00ff"') && out.includes("<specialtype>rectangle</specialtype>"), "rectangle");
  // MSG reads the same titles and coordinates
  const msg = msgParseNdpa(out);
  eq(msg.length, items.length, "MSG sees every annotation");
  eq(
    msg.map((m) => [m.title, Math.round(m.xNm * 1000) / 1000, Math.round(m.yNm * 1000) / 1000]),
    items.map((a) => [a.title, Math.round(anchorOf(a).x * 1000) / 1000, Math.round(anchorOf(a).y * 1000) / 1000]),
    "MSG: same titles and coordinates",
  );
  eq(msg.map((m) => m.type).slice(base.items.length), ["pin", "linear", "freehand", "circle", "freehand"], "MSG: types (a ruler isn't an answer by default)");
  // and re-opening gives the same annotations
  const back = loadNdpa(out).items;
  eq(
    back.map((a) => [a.kind, a.title, a.color, a.points, a.radiusNm ?? null, a.ndpaId]),
    items.map((a) => [a.kind, a.title, a.color, a.points, a.radiusNm ?? null, a.ndpaId]),
    "re-opens identically",
  );
  ok(serializeNdpa(loadNdpa(out).doc, back) === out, "and saves back byte-identically");
});

test("ndpa: a new file, and id collisions", () => {
  const a = makeAnnotation("pin", [{ x: 1, y: 2 }], { color: "#00ff00", items: [], title: "Q1" });
  const out = serializeNdpa(null, [a]);
  ok(out === `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<annotations>\n\t<ndpviewstate id="1">\n\t\t<title>Q1</title>\n\t\t<details/>\n\t\t<coordformat>nanometers</coordformat>\n\t\t<lens>10.000000</lens>\n\t\t<x>1</x>\n\t\t<y>2</y>\n\t\t<z>0</z>\n\t\t<showtitle>1</showtitle>\n\t\t<showhistogram>0</showhistogram>\n\t\t<showlineprofile>0</showlineprofile>\n\t\t<annotation type="pin" displayname="AnnotatePin" color="#00ff00">\n\t\t\t<x>1</x>\n\t\t\t<y>2</y>\n\t\t\t<icon>pingreen</icon>\n\t\t\t<stricon>iconpingreen</stricon>\n\t\t</annotation>\n\t</ndpviewstate>\n</annotations>\n\n`, "exactly NDP.view's layout");
  const { doc } = loadNdpa(SHAPES);
  const clash = serializeNdpa(doc, [{ ...a, ndpaId: 3 }, { ...a, id: "b", ndpaId: 3 }]);
  ok(clash.includes('id="15"') && clash.includes('id="16"'), "colliding ids get fresh ones above the file's");
  eq(nextNdpaId(doc as NdpaDocument, [{ ...a, ndpaId: 20 }]), 21, "nextNdpaId");
});

test("ndpa: tolerant parse", () => {
  const odd = `<annotations><ndpviewstate id="x"><annotation type="Pin" color="0f0"><x> 5 </x><y>6</y></annotation></ndpviewstate><ndpviewstate><title>poly</title><annotation type="polygon"><pointlist><point><x>0</x><y>0</y></point><point><x>1</x><y>0</y></point><point><x>1</x><y>1</y></point></pointlist></annotation></ndpviewstate></annotations>`;
  const { doc, items } = loadNdpa(odd);
  eq(items.map((a) => [a.kind, a.color, a.ndpaId]), [["pin", "#00ff00", null], ["freehand", "#00ff00", null]], "odd type case / colour / ids still read");
  ok(serializeNdpa(doc, items) === odd, "and untouched (no declaration added to a file without one)");
  const moved = serializeNdpa(doc, [{ ...items[0], points: [{ x: 7, y: 8 }] }, items[1]]);
  ok(moved.includes("<x>7</x><y>8</y>") && msgParseNdpa(moved)[0].xNm === 7, "edited in place, MSG reads it");
  let threw = false;
  try {
    loadNdpa("<annotations><oops></annotations>");
  } catch {
    threw = true;
  }
  ok(threw, "broken XML throws (the file is then never overwritten)");
});

// ---------------------------------------------------------------- model

test("annotations: model helpers", () => {
  eq(rectFrom({ x: 0, y: 0 }, { x: 10.4, y: 5 }), [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }], "rectangle corners");
  const a = makeAnnotation("freehand", [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 2000 }, { x: 0, y: 2000 }], { color: "#123456", items: [] });
  eq(moveBy(a, 10, -5).points[0], { x: 10, y: -5 }, "move");
  eq(measureText(a), "4.00 µm² · perimeter 8.00 µm", "area");
  eq(measureText(a, false), "4.0 px² · perimeter 8.0 px", "uncalibrated: px");
  eq(measureText({ kind: "ruler", points: [{ x: 0, y: 0 }, { x: 300000, y: 400000 }] }), "500 µm", "ruler µm");
  eq(measureText({ kind: "ruler", points: [{ x: 0, y: 0 }, { x: 3e6, y: 4e6 }] }), "5.00 mm", "ruler mm");
  eq(measureText({ kind: "ruler", points: [{ x: 0, y: 0 }, { x: 3000, y: 4000 }] }, false), "5.0 px", "ruler px");
  eq(makeAnnotation("pin", [{ x: 0, y: 0 }], { color: "#10e020", items: [] }).color, "#00ff00", "pins snap to NDP.view pin colours");
  eq(nearestPinColor("#ee1111").name, "red", "nearest pin colour");
  const pins = [makeAnnotation("pin", [{ x: 0, y: 0 }], { color: "#00ff00", items: [], title: "Q1" })];
  pins.push({ ...pins[0], id: "z", title: " q1 " });
  eq([...duplicateTitles(pins).values()], [[pins[0].id, "z"]], "duplicate titles (trimmed, any case)");
  eq(defaultTitle("pin", pins), "Pin 3", "default title");
});

test("annotations: store actions are single undo steps", () => {
  const s = () => useStore.getState();
  s().setAnnotations({ items: [], undo: [], redo: [], selection: [] });
  const a = makeAnnotation("pin", [{ x: 0, y: 0 }], { color: "#00ff00", items: [], title: "Q1" });
  addAnnotation(a);
  eq(s().annotations.selection, [a.id], "new annotation selected");
  updateAnnotation(a.id, { title: "Q2" });
  updateAnnotation(a.id, { title: "Q2" });
  eq(s().annotations.undo.length, 2, "no-op updates aren't undo steps");
  deleteAnnotations([a.id]);
  eq(s().annotations.items.length, 0, "deleted");
  s().undo();
  eq(s().annotations.items[0]?.title, "Q2", "undo delete");
  s().undo();
  eq(s().annotations.items[0]?.title, "Q1", "undo rename");
  s().setAnnotations({ items: [], undo: [], redo: [], selection: [], save: "idle" });
});

test("annotations: hit testing (screen space)", () => {
  // 1 screen px = 100 nm, origin at 0
  const k = 0.01;
  const coords = {
    nmToScreen: (p: { x: number; y: number }) => ({ x: p.x * k, y: p.y * k }),
    screenToNm: (p: { x: number; y: number }) => ({ x: p.x / k, y: p.y / k }),
    screenPxPerNm: () => k,
  } as unknown as ViewerCoords;
  const pin = makeAnnotation("pin", [{ x: 10000, y: 10000 }], { color: "#00ff00", items: [] });
  const box = makeAnnotation("rectangle", rectFrom({ x: 20000, y: 20000 }, { x: 40000, y: 40000 }), { color: "#00ff00", items: [] });
  const circ = makeAnnotation("circle", [{ x: 60000, y: 10000 }], { color: "#00ff00", items: [], radiusNm: 1000 });
  const list = [pin, box, circ];
  eq(hitTest(coords, list, { x: 100, y: 100 })?.id, pin.id, "pin needle tip");
  eq(hitTest(coords, list, { x: 112, y: 88 })?.id, pin.id, "pin head");
  eq(hitTest(coords, list, { x: 300, y: 201 })?.part, "edge", "rectangle edge");
  eq(hitTest(coords, list, { x: 300, y: 300 })?.part, "inside", "rectangle inside");
  eq(hitTest(coords, list, { x: 610, y: 100 })?.id, circ.id, "circle edge");
  eq(hitTest(coords, list, { x: 400, y: 400 }, { selection: [box.id] })?.handle, { kind: "vertex", index: 2 }, "corner handle of the selection");
  eq(hitTest(coords, list, { x: 610, y: 100 }, { selection: [circ.id] })?.handle, { kind: "radius" }, "radius handle");
  eq(hitTest(coords, list, { x: 100, y: 100 }, { hidden: [pin.id] }), null, "hidden ones aren't hit");
  eq(hitTest(coords, list, { x: 900, y: 900 }), null, "miss");
  near(withVertex(box, 0, { x: 1.4, y: 2.6 }).points[0].y, 3, 0, "vertex rounding");
});

test("autosave: where to read and write", () => {
  const p = { primary: "/s/a.ndpi.ndpa", fallback: "/data/x/a.ndpi.ndpa" };
  eq(choosePaths({ ...p, primaryExists: true, primaryWritable: true, fallbackExists: true }), { read: p.primary, write: p.primary, fallback: false }, "normal folder");
  eq(choosePaths({ ...p, primaryExists: false, primaryWritable: true, fallbackExists: false }), { read: null, write: p.primary, fallback: false }, "no file yet");
  eq(choosePaths({ ...p, primaryExists: true, primaryWritable: false, fallbackExists: false }), { read: p.primary, write: p.fallback, fallback: true }, "read-only: start from the slide's file");
  eq(choosePaths({ ...p, primaryExists: true, primaryWritable: false, fallbackExists: true }), { read: p.fallback, write: p.fallback, fallback: true }, "read-only: our saved copy wins");
});
