/**
 * TODO(annotations builder): annotation model helpers (create/move/rename/delete, hit-testing,
 * measurement text via lib/measure.ts, NDP.view pin colour/icon mapping) and painting.
 * Owner: annotations (CONTRACTS.md). Currently a stub.
 *
 * CONTRACT: `paintAnnotations` draws the given annotations onto a 2D canvas using `coords`
 * (screen space = the canvas' CSS px). The Snapshot feature calls it to burn annotations into PNGs.
 */
import type { Annotation } from "./types";
import type { ViewerCoords } from "./viewerContext";
import { uid } from "./util";

export interface PaintOptions {
  selection?: ReadonlySet<string>;
  showTitles?: boolean;
  /** device pixel ratio of the canvas (default 1) */
  scale?: number;
}

export function paintAnnotations(ctx: CanvasRenderingContext2D, coords: ViewerCoords, items: readonly Annotation[], opts: PaintOptions = {}): void {
  void ctx;
  void coords;
  void items;
  void opts;
}

/** a new app-local annotation id */
export const newAnnotationId = () => `a${uid()}`;
