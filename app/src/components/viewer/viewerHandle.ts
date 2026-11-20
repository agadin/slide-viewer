/**
 * The open OpenSeadragon viewer for code outside the React tree (lib/keys.ts, the toolbar), plus the
 * zoom / pan actions they share. Owner: viewer. SlideViewer.tsx sets it; everything here is a no-op
 * while no slide is open.
 */
import type OpenSeadragon from "openseadragon";
import type { SlideInfo } from "../../lib/types";
import { imageZoomForMag } from "./viewMath";

let active: { viewer: OpenSeadragon.Viewer; info: SlideInfo } | null = null;

export const setActiveViewer = (v: OpenSeadragon.Viewer | null, info: SlideInfo | null) => {
  active = v && info ? { viewer: v, info } : null;
};
export const getActiveViewer = () => active;

/** zoom the view about its centre */
export function zoomBy(factor: number) {
  if (!active) return;
  active.viewer.viewport.zoomBy(factor);
  active.viewer.viewport.applyConstraints();
}

/** zoom so the slide shows `imageZoom` screen px per image px (1 = 1:1), keeping the centre */
export function zoomToImageZoom(imageZoom: number) {
  if (!active) return;
  const { viewer, info } = active;
  const vz = (imageZoom * info.width) / viewer.viewport.getContainerSize().x;
  viewer.viewport.zoomTo(vz);
  viewer.viewport.applyConstraints();
}

/** zoom to an objective-style magnification (mag = 10 / µm per screen px) */
export function zoomToMag(mag: number) {
  if (!active) return;
  zoomToImageZoom(imageZoomForMag(mag, active.info.mppX));
}

/** pan by a fraction of the view (dx, dy in screen directions, so it follows rotation) */
export function panByScreen(fx: number, fy: number) {
  if (!active) return;
  const vp = active.viewer.viewport;
  const size = vp.getContainerSize();
  const px = vp.pixelFromPoint(vp.getCenter(false), false).clone(); // a Point without importing OSD at load
  px.x += fx * size.x;
  px.y += fy * size.y;
  const to = vp.pointFromPixel(px, false);
  vp.panTo(to);
  vp.applyConstraints();
}
