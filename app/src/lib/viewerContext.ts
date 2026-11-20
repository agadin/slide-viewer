/**
 * What the OpenSeadragon core (components/SlideViewer.tsx) shares with the features that plug into it
 * (annotations layer, navigator, scale bar, z slider, snapshot, filters). FROZEN CONTRACT (CONTRACTS.md).
 *
 * Coordinate spaces:
 *  - image:  level-0 pixels of the slide
 *  - nm:     NDP.view nanometres from the slide centre (lib/coords.ts) — what .ndpa files store
 *  - screen: CSS pixels relative to the viewer element's top-left (OSD "viewer element" coordinates)
 * Screen conversions go through OSD's viewport, so they follow rotation (and flips) automatically.
 */
import { createContext, useContext, useEffect } from "react";
import type OpenSeadragon from "openseadragon";
import type { SlideInfo } from "./types";
import type { Pt } from "./coords";

export interface ViewerCoords {
  imageToNm: (p: Pt) => Pt;
  nmToImage: (p: Pt) => Pt;
  imageToScreen: (p: Pt) => Pt;
  screenToImage: (p: Pt) => Pt;
  nmToScreen: (p: Pt) => Pt;
  screenToNm: (p: Pt) => Pt;
  /** screen px per nm at the current zoom (rotation-independent) */
  screenPxPerNm: () => number;
  /** µm per screen px at the current zoom */
  umPerScreenPx: () => number;
  /** a pointer/mouse event's position in screen coordinates */
  eventToScreen: (e: { clientX: number; clientY: number }) => Pt;
}

export interface ViewerContextValue {
  viewer: OpenSeadragon.Viewer | null;
  info: SlideInfo | null;
  /** the element OSD renders into (position: relative); overlays can be appended to its parent */
  host: HTMLDivElement | null;
  coords: ViewerCoords | null;
  /**
   * Run `cb` in the same animation frame OSD draws in (pan, zoom, rotate, resize, open), so overlays
   * stay planted. Returns an unsubscribe function.
   */
  onFrame: (cb: () => void) => () => void;
}

export const ViewerContext = createContext<ViewerContextValue>({
  viewer: null,
  info: null,
  host: null,
  coords: null,
  onFrame: () => () => {},
});

export const useViewer = () => useContext(ViewerContext);

/** Re-run `cb` on every viewer frame (and once when the viewer changes). */
export function useViewerFrame(cb: () => void) {
  const { onFrame, viewer } = useViewer();
  useEffect(() => {
    cb();
    return onFrame(cb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onFrame, viewer, cb]);
}
