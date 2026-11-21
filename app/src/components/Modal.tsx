import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { useDialogFocus } from "../lib/focus";

/**
 * A dialog over the app: dimmed backdrop (click it to close), the panel, and Esc to close.
 * `after` renders on the backdrop beside the panel (popovers and drag ghosts that must not be clipped by it).
 *
 * a11y: the panel is role="dialog" aria-modal, named by `label` or by its first `.win-title` / heading;
 * the focus moves in when it opens, Tab stays inside, and the focus goes back where it was when it closes
 * (lib/focus.ts). Esc always closes it (or the dialog's own Esc handler does), so it never traps the keyboard.
 */
export function Modal(p: {
  className: string;
  onClose: () => void;
  /** help article for the ? in tooltips inside (data-help) */
  help?: string;
  /** close on Esc (off when the dialog handles keys itself) */
  escape?: boolean;
  onBackdropClick?: () => void;
  after?: ReactNode;
  /** the dialog's spoken name when it has no visible title */
  label?: string;
  children: ReactNode;
}) {
  const { onClose, escape = true } = p;
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(panel, { trap: true });
  useEffect(() => {
    if (!escape) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [escape, onClose]);
  // name the dialog by its visible title
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || p.label) return;
    const t = el.querySelector<HTMLElement>(".win-title, h1, h2, h3, .sv-snap-title");
    if (!t) return;
    if (!t.id) t.id = titleId;
    el.setAttribute("aria-labelledby", t.id);
  });
  return (
    <div className="modal-backdrop" onMouseDown={onClose} onClick={p.onBackdropClick}>
      <div
        ref={panel}
        className={`modal ${p.className}`}
        role="dialog"
        aria-modal="true"
        aria-label={p.label}
        data-help={p.help}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {p.children}
      </div>
      {p.after}
    </div>
  );
}
