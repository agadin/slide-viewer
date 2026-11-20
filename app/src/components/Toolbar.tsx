/**
 * Floating toolbar over the slide (bottom centre). Owner: viewer (CONTRACTS.md).
 * Tools (Pan V, Pin P, Ruler R, Freehand F, Circle C, Rectangle B) · undo / redo · rotation
 * (90° buttons, Shift-click for the free step, click the angle for a free-rotation slider) · zoom
 * in / out / fit · snapshot.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "../lib/store";
import { useSettings } from "../lib/settings";
import { TOOLS, type Tool } from "../lib/types";
import { rotateBy, rotateStep, rotateTo, zoomToFit } from "../lib/keys";
import { fireMenu } from "../lib/menu";
import { zoomBy } from "./viewer/viewerHandle";
import { signedDeg } from "./viewer/viewMath";
import { IconCircleDash, IconPin, IconPolygon, IconRedo, IconRuler, IconUndo } from "./icons";

const Svg = ({ d, children }: { d?: string; children?: ReactNode }) => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d && <path d={d} />}
    {children}
  </svg>
);
const IconHand = () => <Svg d="M5.5 8V3.8a1 1 0 0 1 2 0V7.5M7.5 7V2.8a1 1 0 0 1 2 0V7.5M9.5 7.2V3.8a1 1 0 0 1 2 0V9c0 2.8-1.6 4.8-4.2 4.8-1.8 0-2.8-.8-3.8-2.4L2.3 9.2a1 1 0 0 1 1.6-1.1l1.6 1.4" />;
const IconRect = () => <Svg d="M2.5 4h11v8h-11z" />;
const IconRotL = () => <Svg d="M3 3v3.5h3.5M3.4 6.3A5 5 0 1 1 3.5 10" />;
const IconRotR = () => <Svg d="M13 3v3.5H9.5M12.6 6.3A5 5 0 1 0 12.5 10" />;
const IconCamera = () => <Svg d="M2.5 5.5h2.5l1.2-1.8h3.6L11 5.5h2.5v7h-11zM8 9.2m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0" />;
const IconFit = () => <Svg d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />;
const IconPlus = () => <Svg d="M8 3.5v9M3.5 8h9" />;
const IconMinus = () => <Svg d="M3.5 8h9" />;

const TOOL_ICON: Record<Tool, () => ReactNode> = {
  pan: IconHand,
  pin: IconPin,
  ruler: IconRuler,
  freehand: IconPolygon,
  circle: IconCircleDash,
  rectangle: IconRect,
};

export function Toolbar() {
  const tool = useStore((s) => s.annotations.tool);
  const setTool = useStore((s) => s.setTool);
  const canUndo = useStore((s) => s.annotations.undo.length > 0);
  const canRedo = useStore((s) => s.annotations.redo.length > 0);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const rotation = useStore((s) => s.view.rotation);
  const info = useStore((s) => s.slide.info);
  const step = useSettings((s) => s.s.viewer.rotateStep) || 15;
  const [rotOpen, setRotOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  // the rotation popover closes on a click elsewhere or Esc
  useEffect(() => {
    if (!rotOpen) return;
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!popRef.current?.contains(t) && !t.closest?.(".rot-readout")) setRotOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setRotOpen(false);
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [rotOpen]);

  if (!info) return null;
  const deg = signedDeg(rotation);
  return (
    <>
      <div className="vtool sv-toolbar" role="toolbar" aria-label="Tools">
        {TOOLS.map((t) => {
          const Icon = TOOL_ICON[t.id];
          return (
            <button
              key={t.id}
              className={`tbtn tool-btn ${tool === t.id ? "on" : ""}`}
              onClick={() => setTool(t.id)}
              title={`${t.label} (${t.key.toUpperCase()})`}
              aria-pressed={tool === t.id}
            >
              <Icon />
              <span className="tkey">{t.key.toUpperCase()}</span>
            </button>
          );
        })}
        <div className="vsep" />
        <button className="tbtn" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)" aria-label="Undo">
          <IconUndo />
        </button>
        <button className="tbtn" onClick={redo} disabled={!canRedo} title="Redo (⌘⇧Z)" aria-label="Redo">
          <IconRedo />
        </button>
        <div className="vsep" />
        <button
          className="tbtn"
          onClick={(e) => (e.shiftKey ? rotateBy(-step) : rotateStep(90, -1))}
          title={`Rotate left 90° (,) · Shift-click: ${step}° (⇧,)`}
          aria-label="Rotate left"
        >
          <IconRotL />
        </button>
        <button className={`tbtn rot-readout ${rotOpen ? "on" : ""}`} onClick={() => setRotOpen(!rotOpen)} title="Rotation: click for free rotation" aria-label="Rotation">
          {Math.round(deg * 10) / 10}°
        </button>
        <button
          className="tbtn"
          onClick={(e) => (e.shiftKey ? rotateBy(step) : rotateStep(90, 1))}
          title={`Rotate right 90° (.) · Shift-click: ${step}° (⇧.)`}
          aria-label="Rotate right"
        >
          <IconRotR />
        </button>
        <div className="vsep" />
        <button className="tbtn" onClick={() => zoomBy(0.5)} title="Zoom out (−)" aria-label="Zoom out">
          <IconMinus />
        </button>
        <button className="tbtn" onClick={zoomToFit} title="Fit the slide (0)" aria-label="Zoom to fit">
          <IconFit />
        </button>
        <button className="tbtn" onClick={() => zoomBy(2)} title="Zoom in (+)" aria-label="Zoom in">
          <IconPlus />
        </button>
        <div className="vsep" />
        <button className="tbtn" onClick={() => fireMenu("snapshot")} title="Save the view as a PNG (⇧S)" aria-label="Snapshot">
          <IconCamera />
        </button>
      </div>
      {rotOpen && (
        <div ref={popRef} className="sv-rot-pop sv-glass" role="dialog" aria-label="Free rotation">
          <span className="muted">Rotate</span>
          <input type="range" min={-180} max={180} step={1} value={Math.round(deg)} onChange={(e) => rotateTo(Number(e.target.value))} aria-label="Rotation angle" />
          <span className="mono">{Math.round(deg)}°</span>
          <button className="btn" onClick={() => rotateTo(0)} disabled={rotation === 0}>
            Reset
          </button>
        </div>
      )}
    </>
  );
}
