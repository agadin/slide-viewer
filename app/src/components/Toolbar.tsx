/**
 * Floating toolbar over the slide. Owner: viewer (CONTRACTS.md).
 * TODO(viewer builder): icons per tool, tooltips with keys, rotation control, zoom readout,
 * snapshot button, shortcut sheet.
 */
import { useStore } from "../lib/store";
import { TOOLS } from "../lib/types";
import { rotateBy, zoomToFit } from "../lib/keys";
import { IconRedo, IconUndo } from "./icons";

export function Toolbar() {
  const tool = useStore((s) => s.annotations.tool);
  const setTool = useStore((s) => s.setTool);
  const canUndo = useStore((s) => s.annotations.undo.length > 0);
  const canRedo = useStore((s) => s.annotations.redo.length > 0);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const rotation = useStore((s) => s.view.rotation);
  const info = useStore((s) => s.slide.info);
  if (!info) return null;
  return (
    <div className="vtool sv-toolbar" role="toolbar" aria-label="Tools">
      {TOOLS.map((t) => (
        <button key={t.id} className={`tbtn ${tool === t.id ? "on" : ""}`} onClick={() => setTool(t.id)} title={`${t.label} (${t.key.toUpperCase()})`}>
          {t.label}
        </button>
      ))}
      <div className="vsep" />
      <button className="tbtn" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)" aria-label="Undo">
        <IconUndo />
      </button>
      <button className="tbtn" onClick={redo} disabled={!canRedo} title="Redo (⌘⇧Z)" aria-label="Redo">
        <IconRedo />
      </button>
      <div className="vsep" />
      <button className="tbtn" onClick={() => rotateBy(-90)} title="Rotate left">
        ⟲
      </button>
      <span className="muted small mono">{rotation}°</span>
      <button className="tbtn" onClick={() => rotateBy(90)} title="Rotate right">
        ⟳
      </button>
      <button className="tbtn" onClick={zoomToFit} title="Zoom to fit (H)">
        Fit
      </button>
    </div>
  );
}
