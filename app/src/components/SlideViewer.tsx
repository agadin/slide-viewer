/**
 * OpenSeadragon core. Owner: viewer builder (with components/viewer/**, Toolbar.tsx, lib/keys.ts).
 *
 * CONTRACT (CONTRACTS.md): this component
 *  - creates the OSD viewer for `slide.info` from the store (tile scheme in lib/backend.ts `tileUrl`),
 *  - applies `view.rotation` and `view.z`, and goes home when `view.homeNonce` changes,
 *  - writes `view.zoom`, `view.umPerScreenPx`, `view.magnification` as the viewport changes,
 *  - provides ViewerContext (lib/viewerContext.ts): the viewer instance, rotation-aware coordinate
 *    helpers and `onFrame`,
 *  - mounts the plug-in points below; their owners fill them in without touching this file:
 *      <AnnotationLayer/> (annotations), useFilterPipeline + filterViewerOptions (filters),
 *      <Navigator/> <ScaleBar/> <ZoomPresets/> <ZSlider/> <Snapshot/> (viewer).
 *
 * Design notes (viewer builder):
 *  - One OSD viewer per open slide: it is created when `slide.info` changes and destroyed (tiles,
 *    drawer, WebGL context and canvas backing store released) before the next one, so memory stays
 *    bounded however many slides are opened in a session.
 *  - Coordinates go through the viewport with `current = true`, so overlays drawn in OSD's frame
 *    follow animated zoom/pan/rotation exactly. The slide is the only content and sits at viewport
 *    x 0…1, so image → viewport is a division by `info.width` (no multi-image warnings while a new
 *    focal plane cross-fades in).
 *  - Focal planes: the new plane is added on top of the old one, and the old one is removed when the
 *    new one has fully loaded (or after a short timeout), so switching z never flashes empty.
 *  - OSD's own keyboard handling is off (it would steal R/F/0/arrows); lib/keys.ts does keys.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import OpenSeadragon from "openseadragon";
import { useStore } from "../lib/store";
import { useSettings } from "../lib/settings";
import { tileUrl } from "../lib/backend";
import { magFromUmPerPx } from "../lib/coords";
import { ViewerContext, type ViewerContextValue } from "../lib/viewerContext";
import { filterViewerOptions, useFilterPipeline } from "../lib/filters/pipeline";
import type { SlideInfo } from "../lib/types";
import { AnnotationLayer } from "./annotations/AnnotationLayer";
import { Navigator } from "./viewer/Navigator";
import { ScaleBar } from "./viewer/ScaleBar";
import { ZoomPresets } from "./viewer/ZoomPresets";
import { ZSlider } from "./viewer/ZSlider";
import { Snapshot } from "./viewer/Snapshot";
import { MAX_ZOOM_PIXEL_RATIO } from "./viewer/viewMath";
import { setActiveViewer } from "./viewer/viewerHandle";
import { makeCoords } from "./viewer/makeCoords";
import "./viewer/viewer.css";

const tileSourceFor = (info: SlideInfo, z: number) => ({
  width: info.width,
  height: info.height,
  tileSize: info.tileSize,
  tileOverlap: 0,
  minLevel: 0,
  maxLevel: info.maxLevel,
  getTileUrl: (level: number, x: number, y: number) => tileUrl(info.id, level, x, y, z),
});

const mkPoint = (x: number, y: number) => new OpenSeadragon.Point(x, y);

type AnyTiledImage = OpenSeadragon.TiledImage & { getFullyLoaded?: () => boolean };

/** free the GPU/canvas memory of a viewer that's going away (WebKit keeps canvas backing stores until GC) */
function releaseViewer(v: OpenSeadragon.Viewer) {
  try {
    v.world.removeAll();
  } catch {
    /* ignore */
  }
  const canvases = Array.from(v.element?.querySelectorAll("canvas") ?? []);
  try {
    v.destroy();
  } catch (e) {
    console.warn("viewer destroy failed", e);
  }
  for (const c of canvases) {
    c.width = 0;
    c.height = 0;
  }
}

export function SlideViewer() {
  const info = useStore((s) => s.slide.info);
  const error = useStore((s) => s.slide.error);
  const loading = useStore((s) => s.slide.loading);
  const rotation = useStore((s) => s.view.rotation);
  const z = useStore((s) => s.view.z);
  const homeNonce = useStore((s) => s.view.homeNonce);
  const vs = useSettings((s) => s.s.viewer);

  const hostRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<OpenSeadragon.Viewer | null>(null);
  const frameCbs = useRef(new Set<() => void>());
  const zRef = useRef(z);
  zRef.current = z;
  /** the focal plane the current viewer shows (or is fading to) */
  const shownZ = useRef(0);
  const vsRef = useRef(vs);
  vsRef.current = vs;

  const onFrame = useCallback((cb: () => void) => {
    frameCbs.current.add(cb);
    return () => void frameCbs.current.delete(cb);
  }, []);

  // --- create / replace the viewer when the slide changes ---
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !info) return;
    const s = vsRef.current;
    const v = OpenSeadragon({
      element: host,
      prefixUrl: "",
      showNavigationControl: false,
      showNavigator: false,
      keyboardNavEnabled: false,
      drawer: "canvas",
      crossOriginPolicy: "Anonymous",
      animationTime: s.animate ? 0.35 : 0,
      springStiffness: 9,
      blendTime: 0.1,
      maxZoomPixelRatio: MAX_ZOOM_PIXEL_RATIO,
      minZoomImageRatio: 0.5,
      visibilityRatio: 0.2,
      imageLoaderLimit: 12,
      maxImageCacheCount: 256,
      degrees: useStore.getState().view.rotation,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: s.dblClickZoom, scrollToZoom: true },
      zoomPerScroll: s.zoomPerScroll,
      ...filterViewerOptions,
      tileSources: tileSourceFor(info, zRef.current),
    } as OpenSeadragon.Options);

    shownZ.current = zRef.current;
    const coords = makeCoords(v, info, host, mkPoint);
    let raf = 0;
    let last = { zoom: NaN, um: NaN };
    const publish = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!v.world || !v.world.getItemCount()) return;
        const um = coords.umPerScreenPx();
        const zoom = v.viewport.getZoom(true);
        if (zoom === last.zoom && um === last.um) return;
        last = { zoom, um };
        useStore.getState().setView({ zoom, umPerScreenPx: um, magnification: magFromUmPerPx(um) });
      });
    };
    // run overlay callbacks in the same frame OSD draws tiles, so overlays stay planted while panning
    const frame = () => {
      for (const cb of frameCbs.current) {
        try {
          cb();
        } catch (e) {
          console.error("viewer frame callback failed", e);
        }
      }
      publish();
    };
    for (const ev of ["update-viewport", "animation", "viewport-change", "resize", "open", "rotate"] as const) v.addHandler(ev, frame);
    v.addHandler("open-failed", (e: { message?: string }) => {
      useStore.getState().setUi({ toast: { text: `Could not show the slide: ${e.message ?? "unknown error"}`, kind: "error" } });
    });

    setViewer(v);
    setActiveViewer(v, info);
    return () => {
      cancelAnimationFrame(raf);
      setActiveViewer(null, null);
      setViewer(null);
      releaseViewer(v);
    };
  }, [info]);

  // --- view state from the store ---
  useEffect(() => {
    if (!viewer) return;
    const cur = viewer.viewport.getRotation(false);
    if (cur === rotation) return;
    // small steps (the free-rotation slider) apply at once; 90° turns animate
    const d = Math.abs(((rotation - cur + 540) % 360) - 180);
    viewer.viewport.setRotation(rotation, !vsRef.current.animate || d < 20);
  }, [viewer, rotation]);

  // focal plane: fade the new plane in over the old one, then drop the old one
  useEffect(() => {
    if (!viewer || !info || z === shownZ.current) return;
    shownZ.current = z;
    const world = viewer.world;
    let done = false;
    let timer = 0;
    const keepOnly = (item: OpenSeadragon.TiledImage) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (shownZ.current !== z) {
        // a newer plane was asked for meanwhile: drop this one, the newer one cleans up the rest
        if (world.getIndexOfItem(item) >= 0) world.removeItem(item);
        return;
      }
      for (let i = world.getItemCount() - 1; i >= 0; i--) {
        const it = world.getItemAt(i);
        if (it !== item) world.removeItem(it);
      }
    };
    viewer.addTiledImage({
      tileSource: tileSourceFor(info, z),
      index: world.getItemCount(),
      success: (ev: { item: AnyTiledImage }) => {
        const item = ev.item;
        if (shownZ.current !== z) {
          // superseded by a newer plane while loading
          world.removeItem(item);
          return;
        }
        if (item.getFullyLoaded?.()) keepOnly(item);
        else {
          item.addOnceHandler("fully-loaded-change", () => keepOnly(item));
          timer = window.setTimeout(() => keepOnly(item), 1500);
        }
      },
    } as unknown as Parameters<OpenSeadragon.Viewer["addTiledImage"]>[0]);
    return () => clearTimeout(timer);
  }, [viewer, info, z]);

  useEffect(() => {
    if (homeNonce) viewer?.viewport.goHome();
  }, [viewer, homeNonce]);

  // mouse / zoom preferences apply to the open viewer without reloading the slide
  useEffect(() => {
    const v = viewer as (OpenSeadragon.Viewer & { zoomPerScroll: number; gestureSettingsMouse: { dblClickToZoom: boolean } }) | null;
    if (!v) return;
    v.zoomPerScroll = vs.zoomPerScroll;
    v.gestureSettingsMouse.dblClickToZoom = vs.dblClickZoom;
    const t = vs.animate ? 0.35 : 0;
    const vp = v.viewport as unknown as Record<string, { animationTime: number }>;
    for (const k of ["centerSpringX", "centerSpringY", "zoomSpring", "degreesSpring"]) if (vp[k]) vp[k].animationTime = t;
  }, [viewer, vs.zoomPerScroll, vs.dblClickZoom, vs.animate]);

  useFilterPipeline(viewer, info);

  const ctx = useMemo<ViewerContextValue>(
    () => ({
      viewer,
      info: viewer ? info : null,
      host: viewer ? hostRef.current : null,
      coords: viewer && info && hostRef.current ? makeCoords(viewer, info, hostRef.current, mkPoint) : null,
      onFrame,
    }),
    [viewer, info, onFrame],
  );

  return (
    <ViewerContext.Provider value={ctx}>
      <div className="viewer-wrap">
        <div ref={hostRef} className="viewer-host" />
        {viewer && info && (
          <>
            <AnnotationLayer />
            <Navigator />
            <ScaleBar />
            <ZoomPresets />
            <ZSlider />
            <Snapshot />
          </>
        )}
        {!info && (
          <div className="viewer-empty">
            {error ? `Could not open slide: ${error}` : loading ? "Opening slide…" : "Choose a slide from the browser on the left."}
          </div>
        )}
      </div>
    </ViewerContext.Provider>
  );
}
