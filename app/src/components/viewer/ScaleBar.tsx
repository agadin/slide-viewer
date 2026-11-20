/**
 * TODO(viewer builder): scale bar in µm/mm (px when info.calibrated is false), from useViewer().coords.umPerScreenPx (settings.viewer.showScaleBar).
 * Owner: viewer (CONTRACTS.md). Currently a stub.
 */
import { useViewer } from "../../lib/viewerContext";

/** Mounted inside the viewer by SlideViewer.tsx (only while a slide is open). */
export function ScaleBar() {
  const { viewer } = useViewer();
  if (!viewer) return null;
  return <div className="stub-mount" data-stub="ScaleBar" hidden />;
}
