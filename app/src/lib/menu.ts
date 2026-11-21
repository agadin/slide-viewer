/**
 * Native menu → frontend. lib.rs emits a "menu" event to the main window with one of these ids
 * (CONTRACTS.md). Handle the ones your feature owns with `useMenuEvent` in your own component.
 */
import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { hasTauri } from "./backend";

export type MenuId =
  | "open_folder" // browser
  | "open_file" // browser: File ▸ Open Slide…
  | "rescan_folder" // browser
  | "export_ndpa" // annotations
  | "snapshot" // viewer (Snapshot.tsx)
  | "check_updates" // release (UpdateBanner.tsx)
  | "undo" // viewer (lib/keys.ts) → store.undo()
  | "redo"
  | "toggle_browser" // App.tsx
  | "toggle_panel" // App.tsx
  | "rotate_left" // viewer
  | "rotate_right"
  | "zoom_fit"
  | "prev_slide" // viewer (lib/keys.ts) → lib/browser.ts stepSlide
  | "next_slide";

/** Run `cb` when the menu item `id` is chosen (and, in tests/dev, when `fireMenu(id)` is called). */
export function useMenuEvent(id: MenuId, cb: () => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const local = (e: Event) => (e as CustomEvent<string>).detail === id && ref.current();
    window.addEventListener("sv-menu", local);
    let un: Promise<() => void> | null = null;
    if (hasTauri) un = listen<string>("menu", ({ payload }) => payload === id && ref.current());
    return () => {
      window.removeEventListener("sv-menu", local);
      void un?.then((f) => f());
    };
  }, [id]);
}

/** Trigger a menu action from the UI (buttons that mirror menu items). */
export const fireMenu = (id: MenuId) => window.dispatchEvent(new CustomEvent("sv-menu", { detail: id }));
