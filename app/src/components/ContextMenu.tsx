/**
 * Generic right-click menu (shared). Open one from anywhere with
 *   useStore.getState().setUi({ menu: { x: e.clientX, y: e.clientY, items: [...] } })
 * App.tsx renders it. Items with a `submenu` open a second menu beside them on hover.
 *
 * Keyboard (WAI-ARIA menu pattern, a11y): focus moves onto the items (roving focus). ↑/↓ move (wrapping),
 * Home/End jump to the first/last item, typing letters jumps to the next item starting with them,
 * → / ↵ / Space open a submenu and focus its first item, ← / Esc close a submenu, ↵ / Space pick,
 * Esc closes the menu, Tab closes it too. A menu opened from the keyboard (⇧F10, the Menu key) starts
 * on its first item; one opened with the mouse starts with nothing highlighted, as before. When the menu
 * closes the focus goes back to where it was when the menu opened (before the picked item runs, so an
 * item that moves the focus on purpose, like Rename, still wins).
 * Roles: menu / menuitem, menuitemradio for ticked items (aria-checked), aria-haspopup + aria-expanded
 * on items with a submenu, aria-disabled on disabled items, separators as role="separator".
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, type ContextMenuState, type MenuItemSpec } from "../lib/store";

type Item = MenuItemSpec | "sep";

// was the last input a key (so a menu that opens now should start on its first item)?
let lastInputKeyboard = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => (lastInputKeyboard = true), true);
  window.addEventListener("pointerdown", () => (lastInputKeyboard = false), true);
}

/** the item to move to for type-ahead `buf`, searching after `from` and wrapping; -1 when none (pure) */
export function typeAheadIndex(labels: readonly string[], from: number, buf: string): number {
  const q = buf.toLowerCase();
  if (!q || !labels.length) return -1;
  // pressing the same letter again steps through the items that start with it
  const same = q.length > 1 && [...q].every((c) => c === q[0]);
  const n = labels.length;
  const start = same || q.length === 1 ? from + 1 : from;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    const l = labels[i].trim().toLowerCase();
    if (l.startsWith(q) || (same && l.startsWith(q[0]))) return i;
  }
  return -1;
}

/** ARIA role of an item: ticked items are radios (colours, styles, zoom presets, the current tool) */
export function itemRole(it: MenuItemSpec): "menuitem" | "menuitemradio" {
  return it.checked !== undefined ? "menuitemradio" : "menuitem";
}

function MenuList(p: {
  items: Item[];
  x: number;
  y: number;
  /** submenus flip to the left edge of their parent when there's no room on the right */
  flipX?: number;
  onPick: (it: MenuItemSpec) => void;
  onClose: () => void;
  onBack?: () => void;
  autoFocus?: boolean;
  /** start on the first item and focus it (menus opened from the keyboard) */
  focusFirst?: boolean;
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const live = p.items.map((it, i) => [it, i] as const).filter(([it]) => it !== "sep" && !it.disabled) as [MenuItemSpec, number][];
  const [pos, setPos] = useState({ x: p.x, y: p.y });
  const [hi, setHi] = useState(() => (p.focusFirst ? (live[0]?.[1] ?? -1) : -1));
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flipX: number; focus: boolean } | null>(null);
  const timer = useRef(0);
  const typed = useRef({ buf: "", at: 0 });

  const btnAt = (i: number) => ref.current?.querySelector<HTMLElement>(`[data-i="${i}"]`) ?? null;

  // keep the menu on screen
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let x = p.x;
    if (x + r.width > window.innerWidth - 8) x = p.flipX !== undefined ? p.flipX - r.width : window.innerWidth - r.width - 8;
    setPos({ x: Math.max(8, x), y: Math.max(8, Math.min(p.y, window.innerHeight - r.height - 8)) });
    if (p.autoFocus !== false || p.focusFirst) {
      const first = p.focusFirst && hi >= 0 ? btnAt(hi) : null;
      (first ?? el).focus({ preventScroll: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.x, p.y, p.flipX, p.items.length, p.autoFocus]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  /** move the highlight (and the focus) to item i, from the keyboard */
  const moveTo = (i: number) => {
    if (i < 0) return;
    setHi(i);
    btnAt(i)?.focus({ preventScroll: true });
  };

  const openSub = (i: number, btn: HTMLElement | null, focus = false) => {
    const it = p.items[i];
    if (!btn || it === "sep" || !it.submenu) return setSub(null);
    // place it against the menu's OUTER edge (not the item's, which sits inside the menu's padding),
    // with the first sub-item level with the hovered item
    const r = btn.getBoundingClientRect();
    const m = ref.current?.getBoundingClientRect() ?? r;
    setSub({ index: i, x: m.right + 4, y: r.top - 7, flipX: m.left - 4, focus });
  };

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const at = live.findIndex(([, i]) => i === hi);
    const key = e.key;
    if (key === "Escape") {
      e.preventDefault();
      return p.onBack ? p.onBack() : p.onClose();
    }
    if (key === "Tab") {
      // a menu isn't part of the tab order: Tab closes it (the focus goes back where it came from)
      e.preventDefault();
      return p.onClose();
    }
    if (key === "ArrowDown") {
      e.preventDefault();
      moveTo(live[(at + 1) % live.length]?.[1] ?? -1);
    } else if (key === "ArrowUp") {
      e.preventDefault();
      moveTo(live[at < 0 ? live.length - 1 : (at - 1 + live.length) % live.length]?.[1] ?? -1);
    } else if (key === "Home") {
      e.preventDefault();
      moveTo(live[0]?.[1] ?? -1);
    } else if (key === "End") {
      e.preventDefault();
      moveTo(live[live.length - 1]?.[1] ?? -1);
    } else if (key === "ArrowRight" && at >= 0 && live[at][0].submenu) {
      e.preventDefault();
      openSub(hi, btnAt(hi), true);
    } else if (key === "ArrowLeft" && p.onBack) {
      e.preventDefault();
      p.onBack();
    } else if ((key === "Enter" || key === " ") && at >= 0) {
      e.preventDefault();
      const it = live[at][0];
      if (it.submenu) openSub(hi, btnAt(hi), true);
      else p.onPick(it);
    } else if (key.length === 1 && key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // type-ahead: letters typed within a second add up ("zo" → Zoom)
      e.preventDefault();
      const now = Date.now();
      typed.current = { buf: (now - typed.current.at < 1000 ? typed.current.buf : "") + key, at: now };
      const j = typeAheadIndex(
        live.map(([it]) => it.label),
        at,
        typed.current.buf,
      );
      if (j >= 0) moveTo(live[j][1]);
    }
  };

  const subItem = sub ? p.items[sub.index] : null;
  return (
    <>
      <div
        ref={ref}
        tabIndex={-1}
        role="menu"
        aria-label={p.label}
        aria-orientation="vertical"
        className={`ctx-menu ${p.className ?? ""}`}
        style={{ left: pos.x, top: pos.y }}
        onKeyDown={onKey}
        onContextMenu={(e) => e.preventDefault()}
      >
        {p.items.map((it, i) =>
          it === "sep" ? (
            <div key={i} className="ctx-sep" role="separator" />
          ) : (
            <button
              key={i}
              data-i={i}
              tabIndex={-1}
              role={itemRole(it)}
              aria-checked={it.checked !== undefined ? !!it.checked : undefined}
              aria-haspopup={it.submenu ? "menu" : undefined}
              aria-expanded={it.submenu ? sub?.index === i : undefined}
              aria-disabled={it.disabled || undefined}
              className={`ctx-item ${it.danger ? "bad" : ""} ${i === hi || sub?.index === i ? "hi" : ""}`}
              disabled={it.disabled}
              onMouseEnter={(e) => {
                setHi(i);
                const btn = e.currentTarget;
                window.clearTimeout(timer.current);
                // a short delay so sweeping the pointer down the list doesn't flash every submenu
                timer.current = window.setTimeout(() => openSub(i, btn), it.submenu ? 60 : 160);
              }}
              onClick={(e) => (it.submenu ? openSub(i, e.currentTarget) : p.onPick(it))}
            >
              <span className="ic" aria-hidden>
                {it.swatch ? <span className="ctx-swatch" style={{ background: it.swatch }} /> : it.checked ? "✓" : null}
              </span>
              <span>{it.label}</span>
              <span className="kk" aria-hidden>
                {it.submenu ? <span className="ctx-chev">›</span> : it.shortcut && <span className="kbd">{it.shortcut}</span>}
              </span>
            </button>
          ),
        )}
      </div>
      {sub && subItem && subItem !== "sep" && subItem.submenu && (
        <MenuList
          key={sub.index}
          items={subItem.submenu}
          x={sub.x}
          y={sub.y}
          flipX={sub.flipX}
          onPick={p.onPick}
          onClose={p.onClose}
          onBack={() => {
            const back = sub.index;
            setSub(null);
            // back onto the item that opened it
            (btnAt(back) ?? ref.current)?.focus({ preventScroll: true });
            setHi(back);
          }}
          autoFocus={false}
          focusFirst={sub.focus}
          label={subItem.label}
          className="ctx-sub"
        />
      )}
    </>
  );
}

export function ContextMenu({ menu }: { menu: ContextMenuState }) {
  const setUi = useStore((s) => s.setUi);
  // where the focus was when the menu opened (read during the first render, before the menu takes it)
  const returnTo = useRef<HTMLElement | null>(typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null);
  const keyboard = useRef(lastInputKeyboard);
  const close = () => {
    setUi({ menu: null });
    const el = returnTo.current;
    if (el && el !== document.body && el.isConnected && typeof el.focus === "function") el.focus({ preventScroll: true });
  };
  const pick = (it: MenuItemSpec) => {
    close();
    it.onSelect?.();
  };
  return (
    <>
      <div className="menu-backdrop" onMouseDown={close} onContextMenu={(e) => (e.preventDefault(), close())} />
      <MenuList key={`${menu.x},${menu.y}`} items={menu.items} x={menu.x} y={menu.y} onPick={pick} onClose={close} focusFirst={keyboard.current} />
    </>
  );
}
