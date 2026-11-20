/**
 * TODO(viewer builder): zoom preset buttons (fit, 1.25×, 2.5×, 5×, 10×, 20×, 40×) and the current magnification readout (lib/coords magFromUmPerPx).
 * Owner: viewer (CONTRACTS.md). Currently a stub.
 */
import { useViewer } from "../../lib/viewerContext";

/** Mounted inside the viewer by SlideViewer.tsx (only while a slide is open). */
export function ZoomPresets() {
  const { viewer } = useViewer();
  if (!viewer) return null;
  return <div className="stub-mount" data-stub="ZoomPresets" hidden />;
}
