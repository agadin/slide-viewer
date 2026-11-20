/**
 * Image px <-> NDP.view nm. FROZEN CONTRACT (CONTRACTS.md): pure functions, no OpenSeadragon.
 * NDP.view stores nanometres from the SLIDE centre:  xNm = (px - width/2) * mppX*1000 + xOffsetNm.
 * Rotation is a view property only: it never changes these coordinates. For screen <-> image
 * conversions (which ARE rotation-aware) use the helpers from lib/viewerContext.ts.
 */
import type { SlideInfo } from "./types";

export type Pt = { x: number; y: number };
type Geo = Pick<SlideInfo, "width" | "height" | "mppX" | "mppY" | "xOffsetNm" | "yOffsetNm">;

export const imageToNm = (i: Geo, p: Pt): Pt => ({
  x: (p.x - i.width / 2) * i.mppX * 1000 + i.xOffsetNm,
  y: (p.y - i.height / 2) * i.mppY * 1000 + i.yOffsetNm,
});

export const nmToImage = (i: Geo, p: Pt): Pt => ({
  x: (p.x - i.xOffsetNm) / (i.mppX * 1000) + i.width / 2,
  y: (p.y - i.yOffsetNm) / (i.mppY * 1000) + i.height / 2,
});

/** a distance in nm on this slide, in level-0 pixels (along x) */
export const nmToPx = (i: Pick<SlideInfo, "mppX">, nm: number) => nm / (i.mppX * 1000);
export const pxToNm = (i: Pick<SlideInfo, "mppX">, px: number) => px * i.mppX * 1000;

/**
 * Objective-style magnification shown in the UI ("10×", "40×"): a 40× scan is about 0.25 µm/px
 * at 1:1, so mag = 10 / (µm per screen px). ZoomPresets and the readout use these.
 */
export const magFromUmPerPx = (umPerScreenPx: number) => 10 / umPerScreenPx;
export const umPerPxFromMag = (mag: number) => 10 / mag;
