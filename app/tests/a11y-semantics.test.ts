// Tests for screen-reader text and semantics helpers (lib/announce.ts). Owner: a11y (screen readers + semantics).
import { test, ok, eq } from "./harness";
import {
  announce,
  announceLog,
  annotationChangeKind,
  colorName,
  describeAnnotation,
  diffAnnotations,
  diffMessage,
  documentTitle,
  kindName,
  openedMessage,
  planeMessage,
  timeMessage,
  rotationMessage,
  sliderValueText,
  slideFacts,
  spokenMag,
  spokenUnits,
  spokenZoom,
  stainMessage,
  treePositions,
  zoomChanged,
} from "../src/lib/announce";
import { useStore } from "../src/lib/store";
import type { Annotation, SlideInfo } from "../src/lib/types";

const ann = (p: Partial<Annotation> & { id: string }): Annotation => ({
  ndpaId: null,
  kind: "pin",
  title: "",
  details: "",
  color: "#00ff00",
  points: [{ x: 0, y: 0 }],
  ...p,
});

const info = (p: Partial<SlideInfo> = {}): SlideInfo =>
  ({
    id: 1,
    path: "/x/VMS104.ndpi",
    tileSize: 256,
    maxLevel: 17,
    format: "openslide",
    vendor: "hamamatsu",
    width: 100000,
    height: 60000,
    mppX: 0.4416,
    mppY: 0.4416,
    calibrated: true,
    xOffsetNm: 0,
    yOffsetNm: 0,
    levels: [],
    zPlanes: [{ index: 0, offsetNm: 0, label: "" }],
    associated: [],
    ...p,
  }) as SlideInfo;

test("a11y: spoken units and colours", () => {
  eq(spokenUnits("245 µm"), "245 micrometres", "µm");
  eq(spokenUnits("0.031 mm² · ⌀ 3 mm"), "0.031 square millimetres, diameter 3 millimetres", "area and diameter");
  eq(spokenUnits("10 µm × 20 µm · 200 µm²"), "10 micrometres by 20 micrometres, 200 square micrometres", "rectangle");
  eq(spokenUnits("12 px"), "12 pixels", "px");
  eq(colorName("#00FF00"), "green", "exact pin colour (case-insensitive)");
  eq(colorName("#ee1111"), "custom colour near red", "custom colour names its nearest");
  eq(kindName({ kind: "pin", pinStyle: "flag" }), "Flag", "flag pins");
  eq(kindName({ kind: "freehand", closed: false }), "Freehand line", "open freehand");
});

test("a11y: annotation row names", () => {
  eq(describeAnnotation(ann({ id: "a", title: "Q1" }), { index: 1, total: 5 }), "“Q1”, pin, green, 2 of 5", "pin with position");
  const r = describeAnnotation(
    ann({ id: "r", kind: "ruler", title: "", color: "#ff0000", points: [{ x: 0, y: 0 }, { x: 245000, y: 0 }] }),
    { index: 0, total: 1, hidden: true, duplicate: true },
  );
  ok(r.startsWith("Untitled, ruler, 245 micrometres, red, hidden, title used more than once"), `ruler: ${r}`);
  ok(r.endsWith("1 of 1"), "ruler position");
  const c = describeAnnotation(ann({ id: "c", kind: "circle", title: "x", radiusNm: 1000000 }), {});
  ok(/square millimetres, diameter 2(\.0+)? millimetres/.test(c), `circle says area and diameter: ${c}`);
  const u = describeAnnotation(ann({ id: "u", kind: "ruler", points: [{ x: 0, y: 0 }, { x: 12000, y: 0 }] }), { calibrated: false });
  ok(/12\.0 pixels/.test(u), `uncalibrated ruler in pixels: ${u}`);
});

test("a11y: annotation change messages", () => {
  const a = ann({ id: "a", title: "Q1" }), b = ann({ id: "b", title: "Q2", kind: "ruler", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
  eq(diffMessage(diffAnnotations([a], [a, b])), "Ruler “Q2” added.", "added");
  eq(diffMessage(diffAnnotations([a, b], [a])), "Ruler “Q2” deleted.", "deleted");
  eq(diffMessage(diffAnnotations([a, b], [])), "2 annotations deleted.", "deleted many");
  eq(diffMessage(diffAnnotations([a], [{ ...a, title: "Q9" }])), "Renamed to “Q9”.", "renamed");
  eq(diffMessage(diffAnnotations([a], [{ ...a, points: [{ x: 5, y: 5 }] }])), "Pin “Q1” moved.", "moved");
  eq(diffMessage(diffAnnotations([a], [{ ...a, color: "#ff0000" }])), "“Q1” is now red.", "recoloured");
  eq(diffMessage(diffAnnotations([a], [{ ...a, details: "x" }])), "Annotation changed.", "other edit");
  eq(diffMessage(diffAnnotations([a], [a])), "", "no change");
});

test("a11y: undo / redo / edit are told apart", () => {
  const st = useStore.getState();
  st.setAnnotations({ items: [], undo: [], redo: [] });
  const s0 = useStore.getState().annotations;
  st.commit([ann({ id: "a", title: "Q1" })]);
  const s1 = useStore.getState().annotations;
  eq(annotationChangeKind(s0, s1), "edit", "commit is an edit");
  st.undo();
  const s2 = useStore.getState().annotations;
  eq(annotationChangeKind(s1, s2), "undo", "undo");
  st.redo();
  const s3 = useStore.getState().annotations;
  eq(annotationChangeKind(s2, s3), "redo", "redo");
  st.setAnnotations({ items: [ann({ id: "z" })], undo: [], redo: [] });
  eq(annotationChangeKind(s3, useStore.getState().annotations), null, "a load is not announced as an edit");
  eq(annotationChangeKind(s3, s3), null, "nothing changed");
  // a commit after an undo clears redo: still an edit, not a redo
  st.setAnnotations({ items: [], undo: [], redo: [] });
  st.commit([ann({ id: "a" })]);
  st.commit([ann({ id: "a" }), ann({ id: "b" })]);
  st.undo();
  const t0 = useStore.getState().annotations;
  st.commit([ann({ id: "c" })]);
  eq(annotationChangeKind(t0, useStore.getState().annotations), "edit", "commit after undo");
  st.setAnnotations({ items: [], undo: [], redo: [] });
});

test("a11y: viewer description and status text", () => {
  eq(spokenMag(10), "10 times", "mag");
  eq(spokenMag(1.254), "1.25 times", "small mag");
  eq(spokenMag(null), "", "no mag");
  eq(spokenZoom(info(), 20, 0.5), "magnification 20 times", "calibrated zoom");
  eq(spokenZoom(info({ calibrated: false }), null, 2), "zoom 50 percent", "uncalibrated zoom");
  eq(spokenZoom(null, 20, 0.5), "", "no slide");
  eq(slideFacts(info()), "100,000 by 60,000 pixels, 0.442 micrometres per pixel", "facts");
  ok(/uncalibrated/.test(slideFacts(info({ calibrated: false }))), "uncalibrated facts");
  ok(/3 focal planes/.test(slideFacts(info({ zPlanes: [0, 1, 2].map((i) => ({ index: i, offsetNm: i * 1000, label: "" })) }))), "planes");
  eq(openedMessage({ name: "VMS104.ndpi", annotations: 3, zoom: "magnification 1.25 times", stain: "H&E stain detected" }), "Opened VMS104.ndpi. 3 annotations. H&E stain detected. Magnification 1.25 times.", "opened");
  eq(openedMessage({ name: "a.svs", annotations: 0, zoom: "" }), "Opened a.svs. No annotations.", "opened, bare");
  eq(stainMessage({ stainType: "he", subtype: null, confidence: 0.82 }), "Stain detected: H&E, 82 percent confidence.", "stain");
  const z = info({ zPlanes: [0, 1, 2].map((i) => ({ index: i, offsetNm: (i - 1) * 1200, label: "" })) });
  eq(planeMessage(z, 2), "Focal plane 3 of 3, 1.2 micrometres.", "plane");
  eq(planeMessage(info(), 0), "", "single plane says nothing");
  const tp = info({ timePoints: [0, 30, 90, 3725].map((s, i) => ({ index: i, seconds: s, label: ["0 s", "30 s", "1 min 30 s", "1 h 02 min"][i] })) });
  eq(timeMessage(tp, 1), "Time point 2 of 4, 30 seconds.", "time point");
  eq(timeMessage(tp, 2), "Time point 3 of 4, 1 minute 30 seconds.", "time point, minutes");
  eq(timeMessage(tp, 3), "Time point 4 of 4, 1 hour 2 minutes.", "time point, hours");
  eq(timeMessage(info({ timePoints: [0, 1].map((i) => ({ index: i, seconds: null, label: `T ${i + 1}` })) }), 1), "Time point 2 of 2.", "time point without times");
  eq(timeMessage(info(), 0), "", "no time series says nothing");
  ok(slideFacts(info({ series: ["a", "b", "c"], seriesIndex: 1, seriesKind: "Position" })).endsWith(", position 2 of 3"), "facts name the position");
  eq(rotationMessage(450), "Rotated to 90 degrees.", "rotation");
  eq(rotationMessage(-360), "Rotation 0 degrees.", "rotation home");
  ok(zoomChanged(null, 5) && zoomChanged(5, 10) && !zoomChanged(10, 10.2), "zoom debounce threshold");
  eq(documentTitle("/a/b/VMS104.ndpi"), "VMS104.ndpi — Slide Viewer", "title with slide");
  eq(documentTitle(null), "Slide Viewer", "title without slide");
  eq(sliderValueText("Gamma", 1.2, 2), "Gamma 1.20", "gamma valuetext");
  eq(sliderValueText("Brightness", -25, 0, "%"), "Brightness minus 25 percent", "percent valuetext");
  eq(sliderValueText("Hue", 30, 0, "°"), "Hue 30 degrees", "degrees valuetext");
});

test("a11y: tree positions for the slide browser", () => {
  const rows = [
    { key: "s1", depth: 0 },
    { key: "d1", depth: 0 },
    { key: "d1/s1", depth: 1 },
    { key: "d1/s2", depth: 1 },
    { key: "d1/d2", depth: 1 },
    { key: "d1/d2/s1", depth: 2 },
    { key: "d3", depth: 0 },
    { key: "d3/s1", depth: 1 },
  ];
  const p = treePositions(rows);
  eq(p.get("s1"), { level: 1, setsize: 3, posinset: 1 }, "top level first");
  eq(p.get("d3"), { level: 1, setsize: 3, posinset: 3 }, "top level last");
  eq(p.get("d1/s2"), { level: 2, setsize: 3, posinset: 2 }, "nested");
  eq(p.get("d1/d2/s1"), { level: 3, setsize: 1, posinset: 1 }, "deep");
  eq(p.get("d3/s1"), { level: 2, setsize: 1, posinset: 1 }, "a new group under another parent");
  eq(treePositions([]).size, 0, "empty tree");
});

test("a11y: announce() records messages and ignores blanks", () => {
  const n = announceLog.length;
  announce("  Saved \n ");
  announce("");
  announce("Save failed", "assertive");
  eq(announceLog.slice(n), [
    { text: "Saved", politeness: "polite" },
    { text: "Save failed", politeness: "assertive" },
  ], "log");
});
