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

/**
 * The part of the viewer not covered by the side panels. The Slides and Image panels float OVER the
 * slide (App.css), so the viewer itself never changes size when they open or close; fitting, centring
 * and the overlay cards use this uncovered area instead.
 */
export function visibleArea(container: HTMLElement): { left: number; right: number; width: number; height: number } {
  const host = container.getBoundingClientRect();
  const covered = (sel: string) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el || getComputedStyle(el).display === "none") return null;
    return el.getBoundingClientRect();
  };
  const side = covered(".sv-side"), panel = covered(".sv-panel");
  const left = side ? Math.max(0, Math.min(host.width, side.right - host.left)) : 0;
  const right = panel ? Math.max(0, Math.min(host.width, host.right - panel.left)) : 0;
  return { left, right, width: Math.max(40, host.width - left - right), height: host.height };
}

/** show the whole slide inside the uncovered area (the "Fit" / home view), honouring rotation */
export function fitVisible(v: OpenSeadragon.Viewer, info: SlideInfo, immediately = true) {
  const vp = v.viewport;
  vp.goHome(true); // OSD's home: the slide fitted to the whole container
  const box = visibleArea(v.container);
  const W = vp.getContainerSize().x, H = vp.getContainerSize().y;
  if (!W || !H) return;
  // the rotated slide's bounding box in image px
  const r = (vp.getRotation() * Math.PI) / 180;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const bw = info.width * c + info.height * s, bh = info.width * s + info.height * c;
  const margin = 0.96; // a little breathing room inside the uncovered area
  const s0 = Math.min(W / bw, H / bh);
  const s1 = Math.min((box.width * margin) / bw, (box.height * margin) / bh);
  vp.zoomBy(s1 / s0, vp.getCenter(true), true);
  // move the slide's centre to the middle of the uncovered area
  const dx = box.left + box.width / 2 - W / 2;
  // (a fresh Point from OSD itself: importing OpenSeadragon here would load it in the headless tests)
  const delta = vp.getCenter(true);
  delta.x = -dx;
  delta.y = 0;
  vp.panBy(vp.deltaPointsFromPixels(delta, true), true);
  if (!immediately) vp.applyConstraints();
}

/** the Fit action for code outside the viewer */
export function fitActive() {
  if (active) fitVisible(active.viewer, active.info);
}
