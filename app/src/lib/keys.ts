/**
 * Global keyboard shortcuts for the main window. Owner: viewer (CONTRACTS.md).
 *
 *   V P R F C B      tools (TOOLS in lib/types.ts)        Esc        back to Pan, then clear the selection
 *   ⌘Z / ⌘⇧Z / ⌘Y    undo / redo                           Delete ⌫   delete the selected annotations
 *   [ ]  ← →         previous / next slide in the folder   0  H       fit the slide
 *   +  −             zoom in / out                         ⇧ arrows   pan
 *   ,  .             rotate 90° left / right               ⇧, ⇧.      rotate by the free step (15°)
 *   PageUp/PageDown  focal plane up / down (z-stacks)      ⇧S         save a snapshot
 *
 * Feature components with keys of their own (the annotation layer's Delete, Enter, Esc while drawing)
 * listen with { capture: true } and call preventDefault(); this hook runs in the bubble phase and
 * skips events that are already handled, typed into fields, or arrive while a context menu is open.
 * `keyAction` is pure (tested in tests/viewer.test.ts); `useGlobalKeys` dispatches it.
 */
import { useEffect } from "react";
import { useStore } from "./store";
import { useSettings } from "./settings";
import { TOOLS, type Tool } from "./types";
import { stepSlide } from "./browser";
import { fireMenu, useMenuEvent } from "./menu";
import { normDeg, snapRotate } from "../components/viewer/viewMath";
import { panByScreen, zoomBy } from "../components/viewer/viewerHandle";

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
  | { kind: "zoom"; factor: number }
  | { kind: "pan"; fx: number; fy: number }
  | { kind: "rotate90"; dir: 1 | -1 }
  | { kind: "rotateFree"; dir: 1 | -1 }
  | { kind: "plane"; dir: 1 | -1 }
  | { kind: "snapshot" };

export interface KeyLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export function keyAction(e: KeyLike): KeyAction | null {
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
    if (k === "arrowleft") return { kind: "pan", fx: -0.25, fy: 0 };
    if (k === "arrowright") return { kind: "pan", fx: 0.25, fy: 0 };
    if (k === "arrowup") return { kind: "pan", fx: 0, fy: -0.25 };
    if (k === "arrowdown") return { kind: "pan", fx: 0, fy: 0.25 };
    if (code === "Comma" || k === "<") return { kind: "rotateFree", dir: -1 };
    if (code === "Period" || k === ">") return { kind: "rotateFree", dir: 1 };
    if (k === "+") return { kind: "zoom", factor: 2 };
    if (k === "s") return { kind: "snapshot" };
    if (k === "_") return { kind: "zoom", factor: 0.5 };
    return null;
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
  }
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
      const a = keyAction(e);
      if (!a) return;
      if (runKeyAction(a)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
