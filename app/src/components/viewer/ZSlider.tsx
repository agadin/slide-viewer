/**
 * TODO(viewer builder): focal-plane slider, shown only when info.zPlanes.length > 1; writes store view.z.
 * Owner: viewer (CONTRACTS.md). Currently a stub.
 */
import { useViewer } from "../../lib/viewerContext";

/** Mounted inside the viewer by SlideViewer.tsx (only while a slide is open). */
export function ZSlider() {
  const { viewer } = useViewer();
  if (!viewer) return null;
  return <div className="stub-mount" data-stub="ZSlider" hidden />;
}
