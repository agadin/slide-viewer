// Keyboard operation (a11y, WCAG 2.1.1 / 2.1.2 / 2.4.3): key mapping with the keyboard cursor, stepping
// through annotations, two-point shapes, nudging, and the context menu's type-ahead and roles.
import { test, ok, eq } from "./harness";
import { keyAction, KEYBOARD_KEYS, runKeyAction } from "../src/lib/keys";
import {
  cycleAnnotation,
  KB_PAN_BIG,
  KB_PAN_STEP,
  makeAnnotation,
  nudgeAnnotations,
  nudgeSelection,
  setKbCursor,
  shapeFromPoints,
  useAnnUi,
} from "../src/lib/annotations";
import { itemRole, typeAheadIndex } from "../src/components/ContextMenu";
import { useStore } from "../src/lib/store";
import type { Annotation } from "../src/lib/types";

test("a11y keyboard: arrows pan with the keyboard cursor, step slides without it", () => {
  eq(keyAction({ key: "ArrowRight" }), { kind: "slide", dir: 1 }, "→ still steps slides with the cursor off");
  eq(keyAction({ key: "ArrowLeft" }, { cursor: false }), { kind: "slide", dir: -1 }, "← steps slides with the cursor off");
  eq(keyAction({ key: "ArrowRight" }, { cursor: true }), { kind: "pan", fx: KB_PAN_STEP, fy: 0 }, "→ pans with the cursor on");
  eq(keyAction({ key: "ArrowUp" }, { cursor: true }), { kind: "pan", fx: 0, fy: -KB_PAN_STEP }, "↑ pans with the cursor on");
  eq(keyAction({ key: "ArrowDown", shiftKey: true }, { cursor: true }), { kind: "pan", fx: 0, fy: KB_PAN_BIG }, "⇧↓ pans further");
  ok(KB_PAN_BIG > KB_PAN_STEP, "⇧ steps are bigger");
  eq(keyAction({ key: "]" }, { cursor: true }), { kind: "slide", dir: 1 }, "] steps slides even with the cursor on");
  eq(keyAction({ key: "ArrowRight", altKey: true }, { cursor: true }), null, "⌥→ is left to the annotation layer (nudge)");
});

test("a11y keyboard: X, N and ⇧N", () => {
  eq(keyAction({ key: "x" }), { kind: "cursor" }, "X toggles the keyboard cursor");
  eq(keyAction({ key: "n" }), { kind: "cycle", dir: 1 }, "N next annotation");
  eq(keyAction({ key: "N", shiftKey: true }), { kind: "cycle", dir: -1 }, "⇧N previous annotation");
  eq(keyAction({ key: "x", metaKey: true }), null, "⌘X is not the cursor");
  ok(KEYBOARD_KEYS.length >= 10 && KEYBOARD_KEYS.every((k) => k.keys && k.action), "every keyboard key is documented in KEYBOARD_KEYS");
  ok(KEYBOARD_KEYS.some((k) => k.keys.includes("⇧F10")), "⇧F10 is documented");
});

test("a11y keyboard: X needs an open slide", () => {
  const before = useStore.getState().slide.info;
  if (before) return; // only meaningful with no slide open
  setKbCursor(false);
  eq(runKeyAction({ kind: "cursor" }), false, "no slide: X does nothing");
  eq(!!useAnnUi.getState().kbCursor, false, "cursor stays off");
});

const ann = (id: string): Pick<Annotation, "id"> => ({ id });

test("a11y keyboard: cycleAnnotation", () => {
  const list = [ann("a"), ann("b"), ann("c"), ann("d")];
  eq(cycleAnnotation(list, [], [], 1), "a", "N from nothing → first");
  eq(cycleAnnotation(list, [], [], -1), "d", "⇧N from nothing → last");
  eq(cycleAnnotation(list, [], ["b"], 1), "c", "N → next");
  eq(cycleAnnotation(list, [], ["a"], -1), "d", "⇧N wraps backwards");
  eq(cycleAnnotation(list, [], ["d"], 1), "a", "N wraps forwards");
  eq(cycleAnnotation(list, ["c"], ["b"], 1), "d", "hidden annotations are skipped");
  eq(cycleAnnotation(list, [], ["a", "c"], 1), "d", "from a multi-selection, steps from the last selected");
  eq(cycleAnnotation(list, ["a", "b", "c", "d"], [], 1), null, "all hidden → nothing");
  eq(cycleAnnotation([], [], [], 1), null, "no annotations → nothing");
});

test("a11y keyboard: two-point shapes", () => {
  const a = { x: 0, y: 0 }, b = { x: 3000.4, y: 4000.6 };
  eq(shapeFromPoints("ruler", a, b), { points: [{ x: 0, y: 0 }, { x: 3000, y: 4001 }] }, "ruler: both ends, rounded");
  const c = shapeFromPoints("circle", a, { x: 3000, y: 4000 });
  eq(c.points, [{ x: 0, y: 0 }], "circle: centre");
  eq(c.radiusNm, 5000, "circle: radius to the second point");
  eq(shapeFromPoints("rectangle", { x: 10, y: 20 }, { x: 30, y: 50 }).points, [{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 50 }, { x: 10, y: 50 }], "rectangle: corner to corner");
  eq(shapeFromPoints("circle", a, a).radiusNm, 1, "circle never has radius 0");
});

test("a11y keyboard: nudging the selection", () => {
  const pin = makeAnnotation("pin", [{ x: 100, y: 100 }], { color: "#00ff00", items: [] });
  const rect = makeAnnotation("rectangle", [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], { color: "#00ff00", items: [pin] });
  const other: Annotation = { ...makeAnnotation("ruler", [{ x: 0, y: 0 }, { x: 5, y: 5 }], { color: "#fff", items: [] }), kind: "other" };
  const out = nudgeAnnotations([pin, rect, other], [pin.id, other.id], 50, -20);
  eq(out[0].points, [{ x: 150, y: 80 }], "selected pin moves");
  ok(out[1] === rect, "unselected shape untouched");
  ok(out[2] === other, "uneditable kinds stay put");

  const st = useStore.getState();
  const items0 = st.annotations.items, sel0 = st.annotations.selection;
  st.setAnnotations({ items: [pin, rect], selection: [rect.id] });
  const undo0 = useStore.getState().annotations.undo.length;
  ok(nudgeSelection(5, 5), "nudgeSelection moves");
  eq(useStore.getState().annotations.items[1].points[0], { x: 5, y: 5 }, "moved by the step");
  eq(useStore.getState().annotations.undo.length, undo0 + 1, "one undo step");
  ok(!nudgeSelection(0, 0), "zero step does nothing");
  useStore.getState().setAnnotations({ selection: [] });
  ok(!nudgeSelection(5, 5), "no selection does nothing");
  useStore.getState().setAnnotations({ items: items0, selection: sel0 });
});

test("a11y keyboard: menu type-ahead and roles", () => {
  const labels = ["Add pin here", "Add flag here", "Measure (ruler)", "Zoom", "Rotate", "Undo", "Redo"];
  eq(typeAheadIndex(labels, -1, "z"), 3, "z → Zoom");
  eq(typeAheadIndex(labels, 0, "a"), 1, "a again → the next item starting with a");
  eq(typeAheadIndex(labels, 1, "a"), 0, "…and wraps");
  eq(typeAheadIndex(labels, 4, "r"), 6, "r from Rotate → Redo");
  eq(typeAheadIndex(labels, 0, "add f"), 1, "a longer prefix picks the match");
  eq(typeAheadIndex(labels, 0, "aa"), 1, "a repeated letter keeps stepping");
  eq(typeAheadIndex(labels, 0, "q"), -1, "no match");
  eq(itemRole({ label: "Red", checked: false }), "menuitemradio", "ticked lists are radios");
  eq(itemRole({ label: "Zoom in" }), "menuitem", "plain item");
});
