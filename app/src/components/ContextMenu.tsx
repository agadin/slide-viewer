/**
 * Generic right-click menu (shared). Open one from anywhere with
 *   useStore.getState().setUi({ menu: { x: e.clientX, y: e.clientY, items: [...] } })
 * App.tsx renders it. Keyboard: ↑/↓ move, ↵ picks, Esc closes.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { useStore, type ContextMenuState, type MenuItemSpec } from "../lib/store";

export function ContextMenu({ menu }: { menu: ContextMenuState }) {
  const setUi = useStore((s) => s.setUi);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const [hi, setHi] = useState(-1);
  const close = () => setUi({ menu: null });
  const live = menu.items.map((it, i) => [it, i] as const).filter(([it]) => it !== "sep" && !it.disabled) as [MenuItemSpec, number][];

  // keep the menu on screen
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)),
    });
    el.focus();
  }, [menu.x, menu.y, menu.items.length]);

  const pick = (it: MenuItemSpec) => {
    close();
    it.onSelect();
  };

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") return close();
    const at = live.findIndex(([, i]) => i === hi);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi(live[(at + 1) % live.length]?.[1] ?? -1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi(live[(at - 1 + live.length) % live.length]?.[1] ?? -1);
    } else if (e.key === "Enter" && at >= 0) {
      e.preventDefault();
      pick(live[at][0]);
    }
  };

  return (
    <>
      <div className="menu-backdrop" onMouseDown={close} onContextMenu={(e) => (e.preventDefault(), close())} />
      <div ref={ref} tabIndex={-1} role="menu" className="ctx-menu" style={{ left: pos.x, top: pos.y }} onKeyDown={onKey}>
        {menu.items.map((it, i) =>
          it === "sep" ? (
            <div key={i} className="ctx-sep" />
          ) : (
            <button
              key={i}
              role="menuitem"
              className={`ctx-item ${it.danger ? "bad" : ""} ${i === hi ? "hi" : ""}`}
              disabled={it.disabled}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(it)}
            >
              <span className="ic" />
              <span>{it.label}</span>
              <span className="kk">{it.shortcut && <span className="kbd">{it.shortcut}</span>}</span>
            </button>
          ),
        )}
      </div>
    </>
  );
}
