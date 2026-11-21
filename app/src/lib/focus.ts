/**
 * Focus management for dialogs and panels (a11y, WCAG 2.4.3 focus order, 2.1.2 no keyboard trap).
 *
 *   useDialogFocus(ref, { trap: true })
 *
 * On open the focus moves into the dialog (to an element with `autofocus` / [data-autofocus], or the
 * first focusable one); while it's open Tab and ⇧Tab wrap round inside it when `trap` is set (a modal
 * dialog: Esc always closes it, so this is not a keyboard trap); on close the focus goes back to where
 * it was, or to the slide when that element is gone, so it's never lost on <body>.
 */
import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** the elements Tab visits inside `root`, in order (visible ones only) */
export function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[inert], [hidden]") && el.getClientRects().length > 0);
}

/** where Tab (dir 1) or ⇧Tab (dir -1) goes from index `i` of `n` focusables, wrapping round (pure) */
export function wrapIndex(i: number, n: number, dir: 1 | -1): number {
  if (n <= 0) return -1;
  if (i < 0) return dir > 0 ? 0 : n - 1;
  return (((i + dir) % n) + n) % n;
}

/** somewhere sensible for the focus when the element it came from has gone: the slide, else the main area */
export function fallbackFocus(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return (
    document.querySelector<HTMLElement>(".openseadragon-canvas") ??
    document.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ??
    document.querySelector<HTMLElement>("main button, header button")
  );
}

/** give the focus back to `el` (or the fallback) without scrolling */
export function restoreFocus(el: Element | null) {
  if (typeof document === "undefined") return;
  const target = el instanceof HTMLElement && el.isConnected && el !== document.body ? el : fallbackFocus();
  target?.focus({ preventScroll: true });
}

export function useDialogFocus(ref: RefObject<HTMLElement | null>, opts: { trap?: boolean; enabled?: boolean } = {}) {
  const { trap = false, enabled = true } = opts;
  useEffect(() => {
    if (!enabled) return;
    const root = ref.current;
    if (!root) return;
    const before = document.activeElement;
    // after the children's own autoFocus has run
    const raf = requestAnimationFrame(() => {
      if (root.contains(document.activeElement)) return;
      const first = root.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? focusables(root)[0] ?? root;
      if (first === root && !root.hasAttribute("tabindex")) root.tabIndex = -1;
      first.focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      if (!trap || e.key !== "Tab" || e.defaultPrevented) return;
      const list = focusables(root);
      if (!list.length) {
        e.preventDefault();
        return;
      }
      const i = list.indexOf(document.activeElement as HTMLElement);
      // only step in when the browser would leave the dialog (first / last element, or focus outside)
      const leaving = i < 0 || (e.shiftKey ? i === 0 : i === list.length - 1);
      if (!leaving) return;
      e.preventDefault();
      list[wrapIndex(i, list.length, e.shiftKey ? -1 : 1)].focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      // only when the focus was inside (or lost): don't pull it away from something the user moved to
      const a = document.activeElement;
      if (!a || a === document.body || root.contains(a) || !a.isConnected) restoreFocus(before);
    };
  }, [ref, trap, enabled]);
}
