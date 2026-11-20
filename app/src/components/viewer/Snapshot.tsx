/**
 * TODO(viewer builder): PNG snapshot export (menu "snapshot"): visible view with filters (applyFiltersToCanvas) and annotations (paintAnnotations), saved with backend.savePng.
 * Owner: viewer (CONTRACTS.md). Currently a stub.
 */
import { useViewer } from "../../lib/viewerContext";

/** Mounted inside the viewer by SlideViewer.tsx (only while a slide is open). */
export function Snapshot() {
  const { viewer } = useViewer();
  if (!viewer) return null;
  return <div className="stub-mount" data-stub="Snapshot" hidden />;
}
