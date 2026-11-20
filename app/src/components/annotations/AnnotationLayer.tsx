/**
 * TODO(annotations builder): draw annotations over the slide and run the drawing tools
 * (pin P, ruler R, freehand F, circle C, rectangle B; pan V leaves the mouse to OpenSeadragon),
 * selection, drag-to-move, double-click rename, right-click menu, Esc cancels.
 * Owner: annotations (CONTRACTS.md). Currently a stub.
 *
 * Mounted inside the viewer by SlideViewer.tsx while a slide is open. Use useViewer() for the OSD
 * instance and coords (nm <-> screen, rotation-aware) and useViewerFrame() to redraw in OSD's frame.
 * Read/write the store's `annotations` slice (commit() = one undo step).
 */
import { useViewer } from "../../lib/viewerContext";

export function AnnotationLayer() {
  const { viewer } = useViewer();
  if (!viewer) return null;
  return <div className="stub-mount" data-stub="AnnotationLayer" hidden />;
}
