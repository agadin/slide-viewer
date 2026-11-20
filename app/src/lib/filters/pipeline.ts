/**
 * Filter pipeline. Owner: filters (CONTRACTS.md §8).
 *
 * Approach (decision): a WebGL POST-PROCESS pass over OpenSeadragon's output canvas rather than a custom OSD
 * drawer shader. OSD 6's WebGLDrawer compiles its shaders inside a private context class and always composites
 * into a 2D output canvas, so a post-process pass is the stable, drawer-agnostic hook: right after OSD draws
 * ("update-viewport" fires after world.draw()), the output canvas is uploaded as a texture and one fragment-shader
 * pass draws the filtered image into a canvas stacked directly above it (OSD's own canvas is made transparent).
 * Because it works on the final, already-rotated screen image, it is correct under rotation by construction, and
 * the same shader filters Snapshot exports (applyFiltersToCanvas). When the filters are neutral or bypassed the
 * pass is switched off entirely (zero cost).
 *
 * Exports kept for the contract: filterViewerOptions, useFilterPipeline(viewer, info), applyFiltersToCanvas(canvas).
 * Also: per-slide filter state (filters.bySlide) and settings.filters.autoOnOpen.
 */
import { useEffect } from "react";
import type OpenSeadragon from "openseadragon";
import { useStore } from "../store";
import { useSettings } from "../settings";
import { DEFAULT_FILTERS, type AutoState, type FilterParams, type SlideInfo, type StainAnalysis } from "../types";
import { applyToRgba, isNeutral, uniformsFor, type FilterUniforms } from "./math";
import { FilterRenderer } from "./gl";
import { runAutoOnOpen } from "./auto";

/** the post-process pass works with whichever drawer SlideViewer picks (canvas or webgl), so nothing is overridden */
export const filterViewerOptions: Partial<OpenSeadragon.Options> = {};

/** the uniforms for the store's current filters, or null when nothing would change (bypassed or neutral) */
export function activeUniforms(): FilterUniforms | null {
  const f = useStore.getState().filters;
  if (!f.enabled) return null;
  const u = uniformsFor(f.params, f.analysis);
  return isNeutral(u) ? null : u;
}

// ---------------------------------------------------------------- live viewer pass

class PostProcess {
  readonly canvas: HTMLCanvasElement;
  private renderer: FilterRenderer | null = null;
  private failed = false;
  private u: FilterUniforms | null = null;
  private hiddenSrc: HTMLCanvasElement | null = null;

  constructor(private viewer: OpenSeadragon.Viewer) {
    const c = document.createElement("canvas");
    c.className = "sv-filter-canvas";
    Object.assign(c.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", pointerEvents: "none", display: "none" });
    this.canvas = c;
    viewer.addHandler("update-viewport", this.onDraw);
  }

  private source(): HTMLCanvasElement | null {
    const c = (this.viewer as unknown as { drawer?: { canvas?: unknown } }).drawer?.canvas;
    return c instanceof HTMLCanvasElement ? c : null;
  }

  /** keep our canvas directly above OSD's output canvas (the drawer can be recreated, e.g. WebGL → canvas fallback) */
  private attach(src: HTMLCanvasElement) {
    const parent = src.parentElement;
    if (!parent) return;
    if (this.canvas.parentElement !== parent || this.canvas.previousSibling !== src) parent.insertBefore(this.canvas, src.nextSibling);
  }

  private show(src: HTMLCanvasElement) {
    if (this.hiddenSrc && this.hiddenSrc !== src) this.hiddenSrc.style.opacity = "";
    src.style.opacity = "0";
    this.hiddenSrc = src;
    this.canvas.style.display = "";
  }

  private hide() {
    if (this.hiddenSrc) this.hiddenSrc.style.opacity = "";
    this.hiddenSrc = null;
    this.canvas.style.display = "none";
  }

  /** filters changed */
  update() {
    this.u = this.failed ? null : activeUniforms();
    if (!this.u) this.hide();
    this.draw();
  }

  private onDraw = () => this.draw();

  private draw() {
    const u = this.u;
    const src = this.source();
    if (!u || !src || !src.width || !src.height) return;
    this.attach(src);
    try {
      this.renderer ??= new FilterRenderer(this.canvas);
      const scale = src.clientWidth ? src.width / src.clientWidth : window.devicePixelRatio || 1;
      this.renderer.render(src, src.width, src.height, u, scale);
      this.show(src);
    } catch (e) {
      // no WebGL (or a tainted canvas): leave the unfiltered image and say so once
      console.error("filters: GPU pass failed", e);
      this.failed = true;
      this.u = null;
      this.hide();
      useStore.getState().setUi({ toast: { text: "Image adjustments need WebGL, which is unavailable here.", kind: "error" } });
    }
  }

  destroy() {
    this.viewer.removeHandler("update-viewport", this.onDraw);
    this.hide();
    this.canvas.remove();
    this.renderer?.dispose();
    this.renderer = null;
  }
}

// ---------------------------------------------------------------- per-slide state + auto on open

const INITIAL_AUTO: AutoState = { status: "idle", error: null, stainType: null, confidence: 0, vectors: null };
let installed = false;

/** the auto state that matches a stored analysis (after a reopen) */
const autoFrom = (a: StainAnalysis | null, auto: AutoState | undefined): AutoState =>
  a
    ? { status: "done", error: null, stainType: a.stainType, confidence: a.confidence, vectors: a.vectors }
    : auto && auto.status !== "running"
      ? auto
      : INITIAL_AUTO;

/**
 * Keeps filter params per slide path (filters.bySlide) and runs settings.filters.autoOnOpen for slides seen for
 * the first time this session. Exported for tests; idempotent.
 */
export function installFilterState() {
  if (installed) return;
  installed = true;
  let freshPath: string | null = null;
  useStore.subscribe((s, prev) => {
    if (s.slide.path !== prev.slide.path) {
      const bySlide = { ...prev.filters.bySlide };
      if (prev.slide.path)
        bySlide[prev.slide.path] = { params: prev.filters.params, auto: autoFrom(prev.filters.analysis, prev.filters.auto), analysis: prev.filters.analysis };
      const saved = s.slide.path ? bySlide[s.slide.path] : undefined;
      freshPath = saved ? null : s.slide.path;
      s.setFilters({
        bySlide,
        params: saved?.params ?? DEFAULT_FILTERS,
        analysis: saved?.analysis ?? null,
        auto: autoFrom(saved?.analysis ?? null, saved?.auto),
      });
      return;
    }
    if (s.slide.openNonce !== prev.slide.openNonce && s.slide.info) {
      const f = s.filters;
      // openSlide resets `auto`; put it back when this slide's analysis is still here (same slide reopened)
      if (f.analysis && f.auto.status === "idle") s.setFilters({ auto: autoFrom(f.analysis, undefined) });
      if (freshPath && freshPath === s.slide.path) {
        freshPath = null;
        void runAutoOnOpen(useSettings.getState().s.filters.autoOnOpen);
      }
    }
  });
}

/** SlideViewer calls this every render (contract). It owns the GPU pass for `viewer`. */
export function useFilterPipeline(viewer: OpenSeadragon.Viewer | null, info: SlideInfo | null): void {
  useEffect(() => installFilterState(), []);
  // "\" toggles before / after (outside text fields)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.key !== "\\") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      const s = useStore.getState();
      s.setFilters({ enabled: !s.filters.enabled });
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
  useEffect(() => {
    if (!viewer || !info) return;
    const pp = new PostProcess(viewer);
    pp.update();
    const unsub = useStore.subscribe((s, prev) => {
      if (s.filters.params !== prev.filters.params || s.filters.enabled !== prev.filters.enabled || s.filters.analysis !== prev.filters.analysis) pp.update();
    });
    return () => {
      unsub();
      pp.destroy();
    };
  }, [viewer, info]);
}

// ---------------------------------------------------------------- snapshots / plain canvases

let snapRenderer: FilterRenderer | null = null;
let snapFailed = false;

export interface ApplyOptions {
  /** defaults: the store's params / analysis; `enabled` is honoured unless params are given */
  params?: FilterParams;
  analysis?: StainAnalysis | null;
  /** device px per CSS px for the sharpen radius (default: window.devicePixelRatio) */
  pxScale?: number;
}

function uniformsForOptions(o: ApplyOptions): FilterUniforms | null {
  if (!o.params) return activeUniforms();
  const u = uniformsFor(o.params, o.analysis === undefined ? useStore.getState().filters.analysis : o.analysis);
  return isNeutral(u) ? null : u;
}

/** CPU path on ImageData (same maths as the shader). Returns a new ImageData, or the input when nothing changes. */
export function applyFiltersToImageData(img: ImageData, o: ApplyOptions = {}): ImageData {
  const u = uniformsForOptions(o);
  if (!u) return img;
  const data = applyToRgba(img.data, img.width, img.height, u, o.pxScale ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1));
  return new ImageData(data, img.width, img.height);
}

/**
 * The current filters applied to a plain canvas (Snapshot export, previews). Returns a NEW canvas with the
 * filtered image, or `src` itself when no filter is active. Uses WebGL, falling back to the CPU.
 */
export function applyFiltersToCanvas(src: HTMLCanvasElement, o: ApplyOptions = {}): HTMLCanvasElement {
  const u = uniformsForOptions(o);
  if (!u || !src.width || !src.height) return src;
  const pxScale = o.pxScale ?? (window.devicePixelRatio || 1);
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext("2d");
  if (!ctx) return src;
  if (!snapFailed) {
    try {
      snapRenderer ??= new FilterRenderer(document.createElement("canvas"), { preserve: true });
      const max = snapRenderer.gl.getParameter(snapRenderer.gl.MAX_TEXTURE_SIZE) as number;
      if (src.width <= max && src.height <= max) {
        snapRenderer.render(src, src.width, src.height, u, pxScale);
        ctx.drawImage(snapRenderer.canvas, 0, 0);
        return out;
      }
    } catch (e) {
      console.warn("filters: WebGL snapshot pass failed, using the CPU", e);
      snapFailed = true;
    }
  }
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  ctx.putImageData(new ImageData(applyToRgba(img.data, img.width, img.height, u, pxScale), img.width, img.height), 0, 0);
  return out;
}
