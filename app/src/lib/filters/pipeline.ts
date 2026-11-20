/**
 * TODO(filters builder): owns lib/filters/** and components/AdjustPanel.tsx.
 * Image adjustments on the GPU (gamma, brightness, contrast, saturation, hue, grayscale, invert,
 * sharpen, levels, stain separation, normalisation), interactive at 60 fps while panning.
 *
 * CONTRACT (CONTRACTS.md) — SlideViewer.tsx relies on exactly these three exports:
 *  - filterViewerOptions: spread into the OpenSeadragon options when the viewer is created
 *    (e.g. { drawer: "webgl" } or a custom drawer). Must not set tileSources/element.
 *  - useFilterPipeline(viewer, info): a hook SlideViewer calls every render. It reads the store's
 *    `filters` slice and applies it to the viewer (shader uniforms, post-process pass, …).
 *  - applyFiltersToCanvas(src): the same adjustments applied to a plain canvas (snapshots,
 *    previews). Returns a canvas (may be `src` itself when no filter is active).
 * Currently a no-op.
 */
import type OpenSeadragon from "openseadragon";
import type { SlideInfo } from "../types";

export const filterViewerOptions: Partial<OpenSeadragon.Options> = {};

export function useFilterPipeline(viewer: OpenSeadragon.Viewer | null, info: SlideInfo | null): void {
  void viewer;
  void info;
}

export function applyFiltersToCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  return src;
}
