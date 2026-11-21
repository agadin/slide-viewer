/**
 * Live scale bar (corner from settings.viewer.scaleBarPos, default bottom-left): the largest 1/2/5 × 10ⁿ µm (or mm) that fits about 140 px; image px
 * when the slide is uncalibrated. Updated in OSD's frame by writing to the DOM directly, so it costs
 * no React renders while panning. Owner: viewer (CONTRACTS.md). settings.viewer.showScaleBar.
 */
import { useCallback, useRef } from "react";
import { useViewer, useViewerFrame } from "../../lib/viewerContext";
import { useSettings } from "../../lib/settings";
import { isTilted, useStore } from "../../lib/store";
import { scaleBar } from "./viewMath";

export function ScaleBar() {
  const { viewer, info, coords } = useViewer();
  const show = useSettings((s) => s.s.viewer.showScaleBar);
  const tilted = useStore((s) => isTilted(s.view));
  const pos = useSettings((s) => s.s.viewer.scaleBarPos) ?? "bottom-left";
  const toolbar = useSettings((s) => s.s.viewer.showToolbar);
  const zoomBar = useSettings((s) => s.s.viewer.showZoomBar);
  const map = useSettings((s) => s.s.viewer.showNavigator);
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

  if (!viewer || !info || !show || tilted) return null;
  return (
    <div ref={boxRef} className={`sv-scalebar sv-glass at-${pos} ${toolbar ? "above-tools" : ""} ${zoomBar ? "below-zoom" : ""} ${map ? "below-map" : ""}`} title={info.calibrated ? undefined : "This image has no pixel size, so lengths are in image pixels"}>
      <span className="sr-only">Scale bar: </span>
      <span ref={labelRef} className="label" />
      <div ref={barRef} className="bar" aria-hidden />
    </div>
  );
}
