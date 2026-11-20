/**
 * Rotation-aware screen <-> image <-> nm conversions for one OSD viewer (ViewerContext `coords`).
 * Owner: viewer. Uses the viewport with `current = true` so overlays drawn in OSD's frame follow the
 * animated view exactly. The slide sits at viewport x 0..1 (OSD's default for a single image), so
 * image -> viewport is a division by `info.width`; this stays exact while two focal planes overlap.
 */
import type OpenSeadragon from "openseadragon";
import { imageToNm, nmToImage, type Pt } from "../../lib/coords";
import type { ViewerCoords } from "../../lib/viewerContext";
import type { SlideInfo } from "../../lib/types";

/** the parts of OSD's viewport makeCoords uses (so tests can pass a fake) */
export type CoordsViewport = Pick<OpenSeadragon.Viewport, "pixelFromPoint" | "pointFromPixel" | "getBoundsNoRotate" | "getContainerSize">;

/** Rotation-aware conversions for one viewer (see the header for why this divides by info.width). */
/**
 * `point` builds an OpenSeadragon.Point (SlideViewer passes `(x, y) => new OpenSeadragon.Point(x, y)`);
 * it's a parameter so this module doesn't load OSD (tests run it without a DOM).
 */
export function makeCoords(
  v: { viewport: CoordsViewport },
  info: SlideInfo,
  host: Pick<HTMLElement, "getBoundingClientRect">,
  point: (x: number, y: number) => OpenSeadragon.Point,
): ViewerCoords {
  const W = info.width;
  const imageToScreen = (p: Pt): Pt => {
    const r = v.viewport.pixelFromPoint(point(p.x / W, p.y / W), true);
    return { x: r.x, y: r.y };
  };
  const screenToImage = (p: Pt): Pt => {
    const r = v.viewport.pointFromPixel(point(p.x, p.y), true);
    return { x: r.x * W, y: r.y * W };
  };
  /** screen px per image px (rotation doesn't change lengths) */
  const screenPerImagePx = () => {
    const b = v.viewport.getBoundsNoRotate(true);
    const size = v.viewport.getContainerSize();
    return size.x / b.width / W;
  };
  const screenPxPerNm = () => screenPerImagePx() / (info.mppX * 1000);
  return {
    imageToNm: (p) => imageToNm(info, p),
    nmToImage: (p) => nmToImage(info, p),
    imageToScreen,
    screenToImage,
    nmToScreen: (p) => imageToScreen(nmToImage(info, p)),
    screenToNm: (p) => imageToNm(info, screenToImage(p)),
    screenPxPerNm,
    umPerScreenPx: () => 1 / (screenPxPerNm() * 1000),
    eventToScreen: (e) => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    },
  };
}
