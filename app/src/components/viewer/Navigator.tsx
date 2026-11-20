/**
 * TODO(viewer builder): overview map of the whole slide with the current view; click/drag to move (settings.viewer.showNavigator).
 * Owner: viewer (CONTRACTS.md). Currently a stub.
 */
import { useViewer } from "../../lib/viewerContext";

/** Mounted inside the viewer by SlideViewer.tsx (only while a slide is open). */
export function Navigator() {
  const { viewer } = useViewer();
  if (!viewer) return null;
  return <div className="stub-mount" data-stub="Navigator" hidden />;
}
