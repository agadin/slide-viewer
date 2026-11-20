/**
 * Global keyboard shortcuts for the main window. Owner: viewer (CONTRACTS.md).
 * TODO(viewer builder): pan/zoom keys, rotation keys, shortcut sheet, rebindable keys if wanted.
 *
 * Working now: tool keys (TOOLS in lib/types.ts), ⌘Z / ⌘⇧Z (store undo/redo), [ ] and ←/→ step
 * through slides (lib/browser.ts stepSlide), H/0 zoom to fit, Esc returns to Pan.
 * Feature components that need keys of their own (e.g. Delete in the annotation layer) handle them
 * in their own listeners; this hook ignores keys typed into fields.
 */
import { useEffect } from "react";
import { useStore } from "./store";
import { TOOLS } from "./types";
import { stepSlide } from "./browser";
import { useMenuEvent } from "./menu";

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

export const rotateBy = (deg: number) => {
  const st = useStore.getState();
  st.setView({ rotation: (((st.view.rotation + deg) % 360) + 360) % 360 });
};
export const zoomToFit = () => {
  const st = useStore.getState();
  st.setView({ homeNonce: st.view.homeNonce + 1 });
};

export function useGlobalKeys() {
  useMenuEvent("undo", () => useStore.getState().undo());
  useMenuEvent("redo", () => useStore.getState().redo());
  useMenuEvent("prev_slide", () => stepSlide(-1));
  useMenuEvent("next_slide", () => stepSlide(1));
  useMenuEvent("rotate_left", () => rotateBy(-90));
  useMenuEvent("rotate_right", () => rotateBy(90));
  useMenuEvent("zoom_fit", zoomToFit);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target) || useStore.getState().ui.menu) return;
      const st = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (mod && k === "y") {
        e.preventDefault();
        st.redo();
        return;
      }
      if (mod || e.altKey) return;
      const tool = TOOLS.find((t) => t.key === k);
      if (tool) {
        st.setTool(tool.id);
        return;
      }
      if (k === "escape") st.setTool("pan");
      else if (k === "[" || k === "arrowleft") stepSlide(-1);
      else if (k === "]" || k === "arrowright") stepSlide(1);
      else if (k === "h" || k === "0") zoomToFit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
