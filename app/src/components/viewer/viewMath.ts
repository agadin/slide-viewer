/**
 * Pure maths for the viewer extras (no OpenSeadragon, no DOM) so it can be unit-tested.
 * Owner: viewer (CONTRACTS.md). Tests: tests/viewer.test.ts.
 *
 * Magnification follows lib/coords.ts: mag = 10 / (µm per screen px), so "40×" = 0.25 µm per CSS px.
 */
import type { Pt } from "../../lib/coords";

/** objective-style zoom presets shown over the slide */
export const ZOOM_PRESETS = [1.25, 2.5, 5, 10, 20, 40] as const;

/** OSD's maxZoomPixelRatio: how far past 1:1 (screen px per image px) the user may zoom */
export const MAX_ZOOM_PIXEL_RATIO = 4;

/** degrees normalised to [0, 360) */
export const normDeg = (d: number) => {
  const r = ((d % 360) + 360) % 360;
  return Math.abs(r - 360) < 1e-9 ? 0 : r;
};

/** degrees normalised to (-180, 180] (for a rotation slider) */
export const signedDeg = (d: number) => {
  const r = normDeg(d);
  return r > 180 ? r - 360 : r;
};

/** the next multiple of `step` in direction `dir` (±1): 0 → 90, 37 → 90, 90 → 180; -1: 37 → 0 */
export function snapRotate(current: number, step: number, dir: 1 | -1): number {
  const c = normDeg(current);
  const k = c / step;
  const eps = 1e-6;
  const next = dir > 0 ? Math.floor(k + eps) + 1 : Math.ceil(k - eps) - 1;
  return normDeg(next * step);
}

/** the slide's native magnification (1:1 screen px per image px) */
export const nativeMag = (mppX: number) => 10 / mppX;

/** screen px per image px (OSD "image zoom") that shows `mag` on a slide of mppX µm/px */
export const imageZoomForMag = (mag: number, mppX: number) => (mppX * mag) / 10;

/** magnification at an image zoom (screen px per image px) */
export const magForImageZoom = (imageZoom: number, mppX: number) => (imageZoom * 10) / mppX;

/**
 * How a preset relates to the slide: "optical" (at or below the scan resolution), "digital"
 * (above it, pixels get enlarged), "off" (past the zoom limit).
 */
export function presetState(mag: number, mppX: number, maxRatio = MAX_ZOOM_PIXEL_RATIO): "optical" | "digital" | "off" {
  const z = imageZoomForMag(mag, mppX);
  if (z > maxRatio + 1e-9) return "off";
  return z > 1 + 1e-6 ? "digital" : "optical";
}

/** "1.25×", "2.5×", "10×", "12.3×", "0.62×" */
export function fmtMag(mag: number | null | undefined): string {
  if (mag == null || !Number.isFinite(mag) || mag <= 0) return "–";
  if (mag >= 100) return `${Math.round(mag)}×`;
  if (mag >= 10) return `${+mag.toFixed(1)}×`;
  return `${+mag.toFixed(2)}×`;
}

/** an uncalibrated slide's zoom as a percentage of 1:1 ("25%", "100%", "3.1%") */
export function fmtPercent(imageZoom: number): string {
  if (!Number.isFinite(imageZoom) || imageZoom <= 0) return "–";
  const p = imageZoom * 100;
  return p >= 10 ? `${Math.round(p)}%` : `${+p.toFixed(1)}%`;
}

/** zoom presets for uncalibrated images, as image zoom (screen px per image px) */
export const PERCENT_PRESETS = [0.125, 0.25, 0.5, 1, 2] as const;

export interface ScaleBarSpec {
  /** bar length in screen px */
  px: number;
  /** the length it stands for, in µm (or image px when uncalibrated) */
  value: number;
  label: string;
}

/**
 * Scale bar: the largest 1/2/5 × 10ⁿ length that is at most `targetPx` screen px long.
 * `umPerScreenPx` is µm per CSS px; uncalibrated slides pass their image px per screen px and get px labels.
 */
export function scaleBar(umPerScreenPx: number, targetPx = 140, calibrated = true): ScaleBarSpec | null {
  if (!Number.isFinite(umPerScreenPx) || umPerScreenPx <= 0) return null;
  const target = targetPx * umPerScreenPx;
  const pow = 10 ** Math.floor(Math.log10(target));
  const value = [5, 2, 1].map((m) => m * pow).find((v) => v <= target * (1 + 1e-9)) ?? pow;
  const px = value / umPerScreenPx;
  return { px, value, label: calibrated ? fmtUm(value) : `${fmtNum(value)} px` };
}

const fmtNum = (v: number) => (v >= 1 ? Math.round(v).toLocaleString("en-US") : `${+v.toPrecision(2)}`);

/** 0.5 → "0.5 µm", 200 → "200 µm", 1000 → "1 mm", 5000 → "5 mm" */
export function fmtUm(um: number): string {
  if (um >= 1000) return `${fmtNum(um / 1000)} mm`;
  if (um < 1) return `${fmtNum(um * 1000)} nm`;
  return `${fmtNum(um)} µm`;
}

// ---------------------------------------------------------------- navigator (overview map)

export interface NavLayout {
  /** overview px per image px */
  scale: number;
  /** canvas size (the rotated overview's bounding box) in CSS px */
  width: number;
  height: number;
  rotation: number;
  /** slide size in image px */
  imgW: number;
  imgH: number;
}

/** the navigator canvas for a w×h slide shown rotated by `rotation`° (clockwise), fitted into maxPx × maxPx */
export function navLayout(imgW: number, imgH: number, rotation: number, maxW: number, maxH = maxW): NavLayout {
  const r = (normDeg(rotation) * Math.PI) / 180;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const bw = imgW * c + imgH * s;
  const bh = imgW * s + imgH * c;
  const scale = Math.min(maxW / Math.max(bw, 1), maxH / Math.max(bh, 1));
  return { scale, width: Math.max(1, Math.round(bw * scale)), height: Math.max(1, Math.round(bh * scale)), rotation: normDeg(rotation), imgW, imgH };
}

/** image px → navigator canvas px (rotated clockwise about the slide centre, like OSD) */
export function navFromImage(L: NavLayout, p: Pt): Pt {
  const r = (L.rotation * Math.PI) / 180;
  const dx = (p.x - L.imgW / 2) * L.scale, dy = (p.y - L.imgH / 2) * L.scale;
  const cos = Math.cos(r), sin = Math.sin(r);
  return { x: L.width / 2 + dx * cos - dy * sin, y: L.height / 2 + dx * sin + dy * cos };
}

/** navigator canvas px → image px */
export function imageFromNav(L: NavLayout, p: Pt): Pt {
  const r = (L.rotation * Math.PI) / 180;
  const dx = p.x - L.width / 2, dy = p.y - L.height / 2;
  const cos = Math.cos(r), sin = Math.sin(r);
  return { x: (dx * cos + dy * sin) / L.scale + L.imgW / 2, y: (-dx * sin + dy * cos) / L.scale + L.imgH / 2 };
}

// ---------------------------------------------------------------- snapshot

/** axis-aligned image-px bounds of some image points, clamped to nothing (may go past the slide) */
export function boundsOf(pts: Pt[]) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 };
}

/**
 * The backend region to request for a snapshot of the screen rectangle (0,0)-(w,h): the image-px bounding
 * box of the four screen corners (rotation makes it bigger than the view), and the output size that keeps
 * `outScale` output px per screen px. The output is capped at `maxOut` px per side.
 */
export function snapshotRegion(corners: Pt[], screenPxPerImagePx: number, outScale: number, maxOut = 8192) {
  const b = boundsOf(corners);
  let k = screenPxPerImagePx * outScale; // output px per image px
  const big = Math.max(b.width, b.height) * k;
  if (big > maxOut) k *= maxOut / big;
  return { ...b, outWidth: Math.max(1, Math.round(b.width * k)), outHeight: Math.max(1, Math.round(b.height * k)), outPerImagePx: k };
}

/** "/a/b/VMS104.ndpi" → "VMS104 view.png" */
export function snapshotName(slidePath: string | null | undefined): string {
  const base = (slidePath ?? "slide").split(/[\\/]/).pop() ?? "slide";
  const stem = base.replace(/\.[^.]+$/, "") || "slide";
  return `${stem} view.png`;
}
