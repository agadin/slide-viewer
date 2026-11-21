/**
 * Focal-plane (z-stack) slider on the right edge. Only shown when the slide has more than one plane.
 * Writes store `view.z` (a ZPlane.index); SlideViewer cross-fades to the new plane.
 * Keys: PageUp / PageDown step planes (lib/keys.ts). Owner: viewer (CONTRACTS.md).
 */
import { useStore } from "../../lib/store";
import { useViewer } from "../../lib/viewerContext";
import { stepPlane } from "../../lib/keys";
import { spokenUnits } from "../../lib/announce";

export function ZSlider() {
  const { viewer, info } = useViewer();
  const z = useStore((s) => s.view.z);
  const setView = useStore((s) => s.setView);
  if (!viewer || !info || info.zPlanes.length <= 1) return null;
  const planes = info.zPlanes;
  const pos = Math.max(0, planes.findIndex((p) => p.index === z));
  const plane = planes[pos];
  const label = plane.label || (plane.offsetNm != null ? `${(plane.offsetNm / 1000).toFixed(1)} µm` : `z ${plane.index}`);
  return (
    <div className="sv-zslider sv-glass" role="group" aria-label="Focal plane">
      <button className="tbtn" onClick={() => stepPlane(1)} disabled={pos >= planes.length - 1} title="Next focal plane (Page Up)" aria-label="Next focal plane">
        ▲
      </button>
      <input
        type="range"
        min={0}
        max={planes.length - 1}
        step={1}
        value={pos}
        onChange={(e) => setView({ z: planes[Number(e.target.value)].index })}
        title="Focal plane"
        aria-label="Focal plane"
        aria-valuetext={`${spokenUnits(label)}, plane ${pos + 1} of ${planes.length}`}
      />
      <button className="tbtn" onClick={() => stepPlane(-1)} disabled={pos <= 0} title="Previous focal plane (Page Down)" aria-label="Previous focal plane">
        ▼
      </button>
      <span className="zlabel" title={label} aria-hidden>
        {label}
      </span>
      <span className="muted" aria-hidden>
        {pos + 1}/{planes.length}
      </span>
    </div>
  );
}
