/**
 * Save the current view as a PNG (menu "snapshot", toolbar camera, ⇧S). Owner: viewer (CONTRACTS.md).
 *
 * The picture is rendered fresh from the backend rather than copied off the screen, so it is sharp at
 * 2× / 4× and doesn't depend on which tiles happen to be loaded or on the drawer:
 *  1. the image-px bounding box of the visible area (bigger than the view when rotated) is fetched with
 *     `slideRegion` (PNG) at the output resolution,
 *  2. the image filters are applied to it (`applyFiltersToCanvas`, filters' contract), unless bypassed,
 *  3. it is drawn through the same affine map OSD uses (rotation included),
 *  4. annotations are painted with `paintAnnotations` (annotations' contract) in screen space,
 *  5. optional scale bar and title are burned in, and the PNG is saved with `savePng` via a save dialog.
 * If the region read fails it falls back to the on-screen canvas.
 */
import { useState } from "react";
import { useViewer } from "../../lib/viewerContext";
import { useStore } from "../../lib/store";
import { useSettings } from "../../lib/settings";
import { useMenuEvent } from "../../lib/menu";
import { basename, dirname, hasTauri, joinPath, pickSavePath, savePng, slideRegion, withExt } from "../../lib/backend";
import { applyFiltersToCanvas } from "../../lib/filters/pipeline";
import { paintAnnotations } from "../../lib/annotations";
import type { ViewerCoords } from "../../lib/viewerContext";
import type { SlideInfo } from "../../lib/types";
import type OpenSeadragon from "openseadragon";
import { Modal } from "../Modal";
import { Check, Seg } from "../prefsUi";
import { fmtMag, scaleBar, snapshotName, snapshotRegion } from "./viewMath";

const BG = "#222225";
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const DEFAULT_OPTS = { scale: 2, annotations: true, scaleBar: true, title: true };

export interface SnapshotOptions {
  scale: number;
  annotations: boolean;
  scaleBar: boolean;
  /** title text burned in (null = none) */
  title: string | null;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const loadBitmap = async (png: Uint8Array) => createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));

/** Render the visible view into a new canvas (output px = CSS px × opts.scale). */
export async function renderSnapshot(
  viewer: OpenSeadragon.Viewer,
  info: SlideInfo,
  coords: ViewerCoords,
  host: HTMLElement,
  opts: SnapshotOptions,
): Promise<HTMLCanvasElement> {
  const st = useStore.getState();
  const s = opts.scale;
  const rect = host.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * s));
  out.height = Math.max(1, Math.round(h * s));
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, out.width, out.height);

  // image px → output px, as an affine map taken from OSD's (rotation-aware) conversions
  const o = coords.imageToScreen({ x: 0, y: 0 });
  const ex = coords.imageToScreen({ x: 1000, y: 0 });
  const ey = coords.imageToScreen({ x: 0, y: 1000 });
  const a = (ex.x - o.x) / 1000, b = (ex.y - o.y) / 1000, c = (ey.x - o.x) / 1000, d = (ey.y - o.y) / 1000;
  const spi = Math.hypot(a, b); // screen px per image px

  const corners = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ].map((p) => coords.screenToImage(p));
  const reg = snapshotRegion(corners, spi, s);
  // only the part that is on the slide
  const x0 = Math.max(0, Math.floor(reg.x)), y0 = Math.max(0, Math.floor(reg.y));
  const x1 = Math.min(info.width, Math.ceil(reg.x + reg.width)), y1 = Math.min(info.height, Math.ceil(reg.y + reg.height));
  let drewSlide = false;
  if (x1 > x0 && y1 > y0) {
    const ow = Math.max(1, Math.round((x1 - x0) * reg.outPerImagePx));
    const oh = Math.max(1, Math.round((y1 - y0) * reg.outPerImagePx));
    try {
      const png = await slideRegion(info.id, { x: x0, y: y0, width: x1 - x0, height: y1 - y0, outWidth: ow, outHeight: oh, z: st.view.z }, "png");
      const bmp = await loadBitmap(png);
      let src: HTMLCanvasElement = document.createElement("canvas");
      src.width = bmp.width;
      src.height = bmp.height;
      src.getContext("2d")!.drawImage(bmp, 0, 0);
      bmp.close();
      // sharpen radius is in CSS px; this canvas has `s` pixels per CSS px
      if (st.filters.enabled) src = applyFiltersToCanvas(src, { pxScale: s });
      ctx.save();
      ctx.setTransform(a * s, b * s, c * s, d * s, o.x * s, o.y * s);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
      src.width = src.height = 0;
      drewSlide = true;
    } catch (e) {
      console.warn("snapshot: region read failed, using the screen", e);
    }
  }
  if (!drewSlide) {
    // fallback: what OSD has drawn (filters applied the same way)
    const screen = (viewer.drawer as unknown as { canvas?: HTMLCanvasElement }).canvas;
    if (screen) {
      let src: HTMLCanvasElement = screen;
      try {
        if (st.filters.enabled) src = applyFiltersToCanvas(screen);
      } catch {
        /* draw unfiltered */
      }
      ctx.drawImage(src, 0, 0, out.width, out.height);
    }
  }

  if (opts.annotations && st.annotations.items.length) {
    ctx.save();
    ctx.setTransform(s, 0, 0, s, 0, 0);
    paintAnnotations(ctx, coords, st.annotations.items, {
      selection: new Set(),
      showTitles: useSettings.getState().s.annotations.showTitles,
      // no `scale`: the transform above already maps CSS px to output px (paintAnnotations would scale again)
    });
    ctx.restore();
  }

  // overlays drawn in CSS px
  ctx.save();
  ctx.setTransform(s, 0, 0, s, 0, 0);
  if (opts.title) {
    ctx.font = `600 13px ${SANS}`;
    const sub = `${fmtMag(st.view.magnification)}${info.calibrated ? "" : " · uncalibrated"}`;
    const tw = Math.max(ctx.measureText(opts.title).width, (ctx.font = `500 11px ${MONO}`, ctx.measureText(sub).width));
    ctx.fillStyle = "rgba(20,20,24,0.66)";
    roundRect(ctx, 12, 12, tw + 20, 42, 10);
    ctx.fill();
    ctx.fillStyle = "#f2f2f4";
    ctx.font = `600 13px ${SANS}`;
    ctx.fillText(opts.title, 22, 30);
    ctx.fillStyle = "#c8c8d0";
    ctx.font = `500 11px ${MONO}`;
    ctx.fillText(sub, 22, 46);
  }
  if (opts.scaleBar) {
    const sb = scaleBar(1 / (coords.screenPxPerNm() * 1000), 160, info.calibrated);
    if (sb) {
      ctx.font = `500 11px ${MONO}`;
      const bw = Math.max(sb.px, ctx.measureText(sb.label).width) + 20;
      const bx = 12, by = h - 12 - 34;
      ctx.fillStyle = "rgba(20,20,24,0.66)";
      roundRect(ctx, bx, by, bw, 34, 9);
      ctx.fill();
      ctx.fillStyle = "#f2f2f4";
      ctx.fillText(sb.label, bx + 10, by + 15);
      ctx.strokeStyle = "#f2f2f4";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(bx + 10, by + 21);
      ctx.lineTo(bx + 10, by + 26);
      ctx.lineTo(bx + 10 + sb.px, by + 26);
      ctx.lineTo(bx + 10 + sb.px, by + 21);
      ctx.stroke();
    }
  }
  ctx.restore();
  return out;
}

const toPng = (c: HTMLCanvasElement) =>
  new Promise<Uint8Array>((res, rej) =>
    c.toBlob((b) => (b ? b.arrayBuffer().then((x) => res(new Uint8Array(x)), rej) : rej(new Error("could not encode the PNG"))), "image/png"),
  );

/** Mounted inside the viewer by SlideViewer.tsx (only while a slide is open). */
export function Snapshot() {
  const { viewer, info, coords, host } = useViewer();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const saved = useSettings((s) => s.s.viewer.snapshot);
  const setSection = useSettings((s) => s.setSection);
  const slidePath = useStore((s) => s.slide.path);
  const o = { ...DEFAULT_OPTS, ...(saved ?? {}) };
  const setOpt = (p: Partial<typeof o>) => setSection("viewer", { snapshot: { ...o, ...p } });

  useMenuEvent("snapshot", () => {
    if (!useStore.getState().slide.info) return;
    setTitle((t) => t || (slidePath ? basename(slidePath).replace(/\.[^.]+$/, "") : ""));
    setOpen(true);
  });

  if (!viewer || !info || !open) return null;
  const rect = host?.getBoundingClientRect();
  const outW = Math.round((rect?.width ?? 0) * o.scale), outH = Math.round((rect?.height ?? 0) * o.scale);

  const save = async () => {
    if (!viewer || !info || !coords || !host) return;
    setBusy(true);
    const toast = useStore.getState().setUi;
    let canvas: HTMLCanvasElement | null = null;
    try {
      const name = snapshotName(slidePath);
      let path: string | null = null;
      if (hasTauri) {
        path = await pickSavePath(slidePath ? joinPath(dirname(slidePath), name) : name, [{ name: "PNG image", extensions: ["png"] }]);
        if (!path) return;
        path = withExt(path, "png");
      }
      canvas = await renderSnapshot(viewer, info, coords, host, {
        scale: o.scale,
        annotations: o.annotations,
        scaleBar: o.scaleBar,
        title: o.title && title.trim() ? title.trim() : null,
      });
      const png = await toPng(canvas);
      if (path) {
        await savePng(path, png);
        toast({ toast: { text: `Saved ${basename(path)}`, kind: "info" } });
      } else {
        const url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      setOpen(false);
    } catch (e) {
      toast({ toast: { text: `Snapshot failed: ${e instanceof Error ? e.message : String(e)}`, kind: "error" } });
    } finally {
      if (canvas) canvas.width = canvas.height = 0;
      setBusy(false);
    }
  };

  return (
    <Modal className="sv-snapshot" onClose={() => !busy && setOpen(false)} help="viewing/snapshot">
      <h2>Save view as PNG</h2>
      <p className="help">The visible part of the slide, with the current adjustments{o.annotations ? " and annotations" : ""}.</p>
      <div className="rows">
        <div className="row">
          <span className="lbl">Resolution</span>
          <Seg
            value={String(o.scale)}
            options={[
              ["1", "1×"],
              ["2", "2×"],
              ["4", "4×"],
            ]}
            onChange={(v) => setOpt({ scale: Number(v) })}
          />
          <span className="size">
            {outW} × {outH} px
          </span>
        </div>
        <div className="row">
          <span className="lbl">Include</span>
          <Check checked={o.annotations} onChange={(v) => setOpt({ annotations: v })}>
            annotations
          </Check>
          <Check checked={o.scaleBar} onChange={(v) => setOpt({ scaleBar: v })}>
            scale bar
          </Check>
        </div>
        <div className="row">
          <span className="lbl">
            <Check checked={o.title} onChange={(v) => setOpt({ title: v })}>
              Title
            </Check>
          </span>
          <input
            type="text"
            value={title}
            disabled={!o.title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              }
            }}
            placeholder="Title on the image"
          />
        </div>
      </div>
      <div className="modal-actions">
        <div className="grow" />
        <button className="btn ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button className="btn light" onClick={() => void save()} disabled={busy} autoFocus>
          {busy ? "Saving…" : hasTauri ? "Save…" : "Download"}
        </button>
      </div>
    </Modal>
  );
}
