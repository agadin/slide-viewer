/**
 * Global keyboard shortcuts for the main window. Owner: viewer (CONTRACTS.md).
 *
 *   V P R F C B      tools (TOOLS in lib/types.ts)        Esc        back to Pan, then clear the selection
 *   ⌘Z / ⌘⇧Z / ⌘Y    undo / redo                           Delete ⌫   delete the selected annotations
 *   [ ]  ← →         previous / next slide in the folder   0  H       fit the slide
 *   +  −             zoom in / out                         ⇧ arrows   pan
 *   ,  .             rotate 90° left / right               ⇧, ⇧.      rotate by the free step (15°)
 *   PageUp/PageDown  focal plane up / down (z-stacks)      ⇧S         save a snapshot
 *   X                keyboard cursor on / off              N  ⇧N      select the next / previous annotation
 *   ← → ↑ ↓          with the keyboard cursor on (and the slide focused): pan a tenth of the view, ⇧ a quarter
 *                    (otherwise ← → step slides, as [ ] always do)
 *
 * The rest of the keyboard cursor (Space / ↵ set points, P pin, ⌥ arrows nudge, ⇧F10 menu, F2 rename)
 * lives in AnnotationLayer.tsx; every key is listed in KEYBOARD_KEYS below.
 *
 * Feature components with keys of their own (the annotation layer's Delete, Enter, Esc while drawing)
 * listen with { capture: true } and call preventDefault(); this hook runs in the bubble phase and
 * skips events that are already handled, typed into fields, or arrive while a context menu is open.
 * With Preferences ▸ Accessibility ▸ "single-key shortcuts only on the slide" on, character keys are
 * ignored unless the slide has the focus (characterKeyBlocked, WCAG 2.1.4); ⌘/Ctrl shortcuts always work.
 * `keyAction` is pure (tested in tests/viewer.test.ts); `useGlobalKeys` dispatches it.
 */
import { useEffect } from "react";
import { useStore } from "./store";
import { useSettings } from "./settings";
import { TOOLS, type Tool } from "./types";
import { stepSlide } from "./browser";
import { fireMenu, useMenuEvent } from "./menu";
import { normDeg, snapRotate } from "../components/viewer/viewMath";
import { getActiveViewer, panByScreen, zoomBy } from "../components/viewer/viewerHandle";
import { announce, describeAnnotation } from "./announce";
import { cycleAnnotation, KB_PAN_BIG, KB_PAN_STEP, requestJump, setKbCursor, useAnnUi } from "./annotations";

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

// ---------------------------------------------------------------- actions (also used by the toolbar)

/** rotate the view by `deg` (clockwise positive); coordinates never change */
export const rotateBy = (deg: number) => {
  const st = useStore.getState();
  st.setView({ rotation: normDeg(st.view.rotation + deg) });
};
export const rotateTo = (deg: number) => useStore.getState().setView({ rotation: normDeg(deg) });
/** rotate to the next multiple of `step` degrees (so 37° → 90° with step 90) */
export const rotateStep = (step: number, dir: 1 | -1) => rotateTo(snapRotate(useStore.getState().view.rotation, step, dir));

export const zoomToFit = () => {
  const st = useStore.getState();
  st.setView({ homeNonce: st.view.homeNonce + 1 });
};

/** next / previous focal plane of the open slide */
export function stepPlane(dir: 1 | -1) {
  const st = useStore.getState();
  const planes = st.slide.info?.zPlanes ?? [];
  if (planes.length <= 1) return;
  const i = Math.max(0, planes.findIndex((p) => p.index === st.view.z));
  const j = Math.min(planes.length - 1, Math.max(0, i + dir));
  if (j !== i) st.setView({ z: planes[j].index });
}

/** delete the selected annotations as one undo step; true when something was deleted */
export function deleteSelection(): boolean {
  const st = useStore.getState();
  const sel = new Set(st.annotations.selection);
  if (!sel.size) return false;
  const keep = st.annotations.items.filter((a) => !sel.has(a.id));
  if (keep.length === st.annotations.items.length) return false;
  st.commit(keep);
  st.select([]);
  return true;
}

// ---------------------------------------------------------------- key → action (pure)

export type KeyAction =
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "tool"; tool: Tool }
  | { kind: "escape" }
  | { kind: "delete" }
  | { kind: "slide"; dir: 1 | -1 }
  | { kind: "fit" }
  | { kind: "map" }
  | { kind: "zoom"; factor: number }
  | { kind: "pan"; fx: number; fy: number }
  | { kind: "rotate90"; dir: 1 | -1 }
  | { kind: "rotateFree"; dir: 1 | -1 }
  | { kind: "plane"; dir: 1 | -1 }
  | { kind: "snapshot" }
  | { kind: "cursor" }
  | { kind: "cycle"; dir: 1 | -1 };

/** what the key handler knows besides the key */
export interface KeyContext {
  /** the keyboard cursor is on and the slide (or nothing) has the focus: arrows pan instead of stepping slides */
  cursor?: boolean;
}

/**
 * Keys for keyboard-only use (a11y), as data for the shortcuts page / Help. `where` says when they work.
 * Single letters work when the focus isn't in a text field.
 */
export const KEYBOARD_KEYS: { keys: string; action: string; where?: string }[] = [
  { keys: "X", action: "Keyboard cursor on / off (a cross-hair at the centre of the view)" },
  { keys: "↵ (slide focused)", action: "Keyboard cursor on" },
  { keys: "← → ↑ ↓", action: "Pan a tenth of the view under the cursor", where: "keyboard cursor on" },
  { keys: "⇧ + arrow", action: "Pan a quarter of the view" },
  { keys: "[ ]", action: "Previous / next slide (← → too while the keyboard cursor is off)" },
  { keys: "Space", action: "Click at the cursor: select what's under it, place a pin, or set a point", where: "keyboard cursor on" },
  { keys: "↵", action: "Pan tool: open the menu at the cursor. Drawing tools: set a point", where: "keyboard cursor on" },
  { keys: "P / ⇧P", action: "Place a pin / flag at the cursor", where: "keyboard cursor on" },
  { keys: "R C B, then Space twice", action: "Ruler, circle (centre, then edge) or rectangle (corner to corner)", where: "keyboard cursor on" },
  { keys: "F, then Space per point", action: "Freehand outline; ⇧↵ or Space on the first point closes it, ⌫ removes the last point", where: "keyboard cursor on" },
  { keys: "N / ⇧N", action: "Select the next / previous annotation and show it" },
  { keys: "⌥ + arrow", action: "Move the selected annotations (⌥⇧ for bigger steps)" },
  { keys: "F2 or ↵", action: "Rename the selected annotation" },
  { keys: "⇧F10 or the Menu key", action: "Menu for the selection, or at the cursor (style, colour, delete, add pin, zoom…)" },
  { keys: "Esc", action: "Cancel the drawing, clear the selection, back to Pan, then keyboard cursor off" },
  { keys: "Tab", action: "Leave the slide (the slide never keeps the focus)" },
  { keys: "In menus", action: "↑ ↓ Home End move, letters jump, → or ↵ opens a submenu, ← or Esc closes it, ↵ or Space picks, Tab closes" },
];

export interface KeyLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export function keyAction(e: KeyLike, ctx: KeyContext = {}): KeyAction | null {
  const mod = !!(e.metaKey || e.ctrlKey);
  const k = e.key.toLowerCase();
  const code = e.code ?? "";
  if (mod && !e.altKey) {
    if (k === "z") return e.shiftKey ? { kind: "redo" } : { kind: "undo" };
    if (k === "y") return { kind: "redo" };
    return null;
  }
  if (mod || e.altKey) return null;
  if (e.shiftKey) {
    if (k === "arrowleft") return { kind: "pan", fx: -KB_PAN_BIG, fy: 0 };
    if (k === "arrowright") return { kind: "pan", fx: KB_PAN_BIG, fy: 0 };
    if (k === "arrowup") return { kind: "pan", fx: 0, fy: -KB_PAN_BIG };
    if (k === "arrowdown") return { kind: "pan", fx: 0, fy: KB_PAN_BIG };
    if (code === "Comma" || k === "<") return { kind: "rotateFree", dir: -1 };
    if (code === "Period" || k === ">") return { kind: "rotateFree", dir: 1 };
    if (k === "+") return { kind: "zoom", factor: 2 };
    if (k === "s") return { kind: "snapshot" };
    if (k === "n") return { kind: "cycle", dir: -1 };
    if (k === "_") return { kind: "zoom", factor: 0.5 };
    return null;
  }
  if (ctx.cursor) {
    if (k === "arrowleft") return { kind: "pan", fx: -KB_PAN_STEP, fy: 0 };
    if (k === "arrowright") return { kind: "pan", fx: KB_PAN_STEP, fy: 0 };
    if (k === "arrowup") return { kind: "pan", fx: 0, fy: -KB_PAN_STEP };
    if (k === "arrowdown") return { kind: "pan", fx: 0, fy: KB_PAN_STEP };
  }
  const tool = TOOLS.find((t) => t.key === k);
  if (tool) return { kind: "tool", tool: tool.id };
  switch (k) {
    case "escape":
      return { kind: "escape" };
    case "delete":
    case "backspace":
      return { kind: "delete" };
    case "[":
    case "arrowleft":
      return { kind: "slide", dir: -1 };
    case "]":
    case "arrowright":
      return { kind: "slide", dir: 1 };
    case "h":
    case "0":
      return { kind: "fit" };
    case "m":
      return { kind: "map" };
    case "x":
      return { kind: "cursor" };
    case "n":
      return { kind: "cycle", dir: 1 };
    case "=":
    case "+":
      return { kind: "zoom", factor: 2 };
    case "-":
      return { kind: "zoom", factor: 0.5 };
    case ",":
      return { kind: "rotate90", dir: -1 };
    case ".":
      return { kind: "rotate90", dir: 1 };
    case "pageup":
      return { kind: "plane", dir: 1 };
    case "pagedown":
      return { kind: "plane", dir: -1 };
  }
  return null;
}

/** run an action; returns false when it did nothing (so the key isn't swallowed) */
export function runKeyAction(a: KeyAction): boolean {
  const st = useStore.getState();
  switch (a.kind) {
    case "undo":
      st.undo();
      return true;
    case "redo":
      st.redo();
      return true;
    case "tool":
      st.setTool(a.tool);
      return true;
    case "escape":
      if (st.annotations.tool !== "pan") st.setTool("pan");
      else if (st.annotations.selection.length) st.select([]);
      else return false;
      return true;
    case "delete":
      return deleteSelection();
    case "slide":
      void stepSlide(a.dir);
      return true;
    case "fit":
      zoomToFit();
      return true;
    case "map": {
      if (!st.slide.info) return false;
      const v = useSettings.getState().s.viewer;
      useSettings.getState().setSection("viewer", { showNavigator: !v.showNavigator });
      return true;
    }
    case "zoom":
      zoomBy(a.factor);
      return true;
    case "pan":
      panByScreen(a.fx, a.fy);
      return true;
    case "rotate90":
      rotateStep(90, a.dir);
      return true;
    case "rotateFree": {
      const step = useSettings.getState().s.viewer.rotateStep || 15;
      rotateBy(a.dir * step);
      return true;
    }
    case "plane":
      stepPlane(a.dir);
      return true;
    case "snapshot":
      if (!st.slide.info) return false;
      fireMenu("snapshot");
      return true;
    case "cursor": {
      if (!st.slide.info) return false;
      const on = !useAnnUi.getState().kbCursor;
      setKbCursor(on);
      // the slide takes the focus so the arrows, Space and ↵ reach it
      if (on) getActiveViewer()?.viewer.canvas.focus({ preventScroll: true });
      return true;
    }
    case "cycle": {
      if (!st.slide.info) return false;
      const id = cycleAnnotation(st.annotations.items, useAnnUi.getState().hidden, st.annotations.selection, a.dir);
      if (!id) return false;
      st.select([id]);
      requestJump(id);
      const list = st.annotations.items.filter((x) => !useAnnUi.getState().hidden.includes(x.id));
      const ann = list.find((x) => x.id === id);
      if (ann) announce(`${describeAnnotation(ann, { index: list.indexOf(ann), total: list.length, calibrated: st.slide.info.calibrated })}. Selected.`);
      return true;
    }
  }
}

/** a key that types a character (letters, digits, + − , . [ ] Space), with or without Shift (WCAG 2.1.4) */
export const isCharacterKey = (e: KeyLike) => e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;

/** is the keyboard focus inside the slide viewer itself (not just nowhere)? */
export function slideHasFocus(t: EventTarget | null): boolean {
  if (typeof document === "undefined") return false;
  const host = getActiveViewer()?.viewer.element;
  return !!host && !!t && host.contains(t as Node);
}

/**
 * Preferences ▸ Accessibility ▸ "Single-key shortcuts only on the slide" (WCAG 2.1.4 character key
 * shortcuts): true when this key must be ignored because the slide doesn't have the focus.
 */
export function characterKeyBlocked(e: KeyLike & { target: EventTarget | null }, onlyOnSlide = !!useSettings.getState().s.a11y?.singleKeysOnSlide): boolean {
  return onlyOnSlide && isCharacterKey(e) && !slideHasFocus(e.target);
}

/** is the focus on the slide (or nowhere), so the keyboard cursor's arrows apply? */
export function focusOnSlide(t: EventTarget | null): boolean {
  if (typeof document === "undefined") return false;
  const el = t as Node | null;
  if (!el || el === document.body || el === document.documentElement) return true;
  const host = getActiveViewer()?.viewer.element;
  return !!host && host.contains(el);
}

export function useGlobalKeys() {
  useMenuEvent("undo", () => useStore.getState().undo());
  useMenuEvent("redo", () => useStore.getState().redo());
  useMenuEvent("prev_slide", () => void stepSlide(-1));
  useMenuEvent("next_slide", () => void stepSlide(1));
  useMenuEvent("rotate_left", () => rotateStep(90, -1));
  useMenuEvent("rotate_right", () => rotateStep(90, 1));
  useMenuEvent("zoom_fit", zoomToFit);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target) || useStore.getState().ui.menu) return;
      // a dialog (snapshot, help) owns the keyboard while it's open
      if (document.querySelector(".modal-backdrop")) return;
      if (characterKeyBlocked(e)) return;
      const a = keyAction(e, { cursor: !!useAnnUi.getState().kbCursor && focusOnSlide(e.target) });
      if (!a) return;
      if (runKeyAction(a)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
