/**
 * Live scale bar (bottom-left): the largest 1/2/5 × 10ⁿ µm (or mm) that fits about 140 px; image px
 * when the slide is uncalibrated. Updated in OSD's frame by writing to the DOM directly, so it costs
 * no React renders while panning. Owner: viewer (CONTRACTS.md). settings.viewer.showScaleBar.
 */
import { useCallback, useRef } from "react";
import { useViewer, useViewerFrame } from "../../lib/viewerContext";
import { useSettings } from "../../lib/settings";
import { scaleBar } from "./viewMath";

export function ScaleBar() {
  const { viewer, info, coords } = useViewer();
  const show = useSettings((s) => s.s.viewer.showScaleBar);
  const barRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const update = useCallback(() => {
    if (!coords || !info || !barRef.current || !labelRef.current || !boxRef.current) return;
    const spec = scaleBar(coords.umPerScreenPx(), 140, info.calibrated);
    boxRef.current.style.visibility = spec ? "visible" : "hidden";
    if (!spec) return;
    barRef.current.style.width = `${spec.px.toFixed(1)}px`;
    if (labelRef.current.textContent !== spec.label) labelRef.current.textContent = spec.label;
  }, [coords, info, show]);

  useViewerFrame(update);

  if (!viewer || !info || !show) return null;
  return (
    <div ref={boxRef} className="sv-scalebar sv-glass" aria-label="Scale bar" title={info.calibrated ? undefined : "This image has no pixel size, so lengths are in image pixels"}>
      <span ref={labelRef} className="label" />
      <div ref={barRef} className="bar" />
    </div>
  );
}
