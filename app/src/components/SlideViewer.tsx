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
 * TODO(viewer): gestures/preferences polish, navigator, smooth z switching, keyboard pan/zoom.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import OpenSeadragon from "openseadragon";
import { useStore } from "../lib/store";
import { useSettings } from "../lib/settings";
import { tileUrl } from "../lib/backend";
import { imageToNm, magFromUmPerPx, nmToImage, type Pt } from "../lib/coords";
import { ViewerContext, type ViewerContextValue, type ViewerCoords } from "../lib/viewerContext";
import { filterViewerOptions, useFilterPipeline } from "../lib/filters/pipeline";
import type { SlideInfo } from "../lib/types";
import { AnnotationLayer } from "./annotations/AnnotationLayer";
import { Navigator } from "./viewer/Navigator";
import { ScaleBar } from "./viewer/ScaleBar";
import { ZoomPresets } from "./viewer/ZoomPresets";
import { ZSlider } from "./viewer/ZSlider";
import { Snapshot } from "./viewer/Snapshot";

const tileSourceFor = (info: SlideInfo, z: number) => ({
  width: info.width,
  height: info.height,
  tileSize: info.tileSize,
  tileOverlap: 0,
  minLevel: 0,
  maxLevel: info.maxLevel,
  getTileUrl: (level: number, x: number, y: number) => tileUrl(info.id, level, x, y, z),
});

function makeCoords(v: OpenSeadragon.Viewer, info: SlideInfo, host: HTMLElement): ViewerCoords {
  const P = (p: Pt) => new OpenSeadragon.Point(p.x, p.y);
  const imageToScreen = (p: Pt): Pt => {
    const r = v.viewport.imageToViewerElementCoordinates(P(p));
    return { x: r.x, y: r.y };
  };
  const screenToImage = (p: Pt): Pt => {
    const r = v.viewport.viewerElementToImageCoordinates(P(p));
    return { x: r.x, y: r.y };
  };
  const screenPxPerNm = () => {
    // distance-based, so rotation doesn't matter
    const a = imageToScreen({ x: 0, y: 0 });
    const b = imageToScreen({ x: 1000, y: 0 });
    return Math.hypot(b.x - a.x, b.y - a.y) / 1000 / (info.mppX * 1000);
  };
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
  /** the focal plane the current viewer shows */
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
      drawer: "canvas",
      crossOriginPolicy: "Anonymous",
      animationTime: s.animate ? 0.35 : 0,
      springStiffness: 9,
      maxZoomPixelRatio: 2.5,
      visibilityRatio: 0.2,
      imageLoaderLimit: 12,
      degrees: useStore.getState().view.rotation,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: s.dblClickZoom, scrollToZoom: true },
      zoomPerScroll: s.zoomPerScroll,
      ...filterViewerOptions,
      tileSources: tileSourceFor(info, zRef.current),
    } as OpenSeadragon.Options);

    shownZ.current = zRef.current;
    const coords = makeCoords(v, info, host);
    let raf = 0;
    const publish = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!v.world.getItemCount()) return;
        const um = coords.umPerScreenPx();
        useStore.getState().setView({ zoom: v.viewport.getZoom(true), umPerScreenPx: um, magnification: magFromUmPerPx(um) });
      });
    };
    // run overlay callbacks in the same frame OSD draws tiles, so overlays stay planted while panning
    const frame = () => {
      for (const cb of frameCbs.current) cb();
      publish();
    };
    for (const ev of ["update-viewport", "animation", "viewport-change", "resize", "open", "rotate"] as const) v.addHandler(ev, frame);

    setViewer(v);
    return () => {
      cancelAnimationFrame(raf);
      setViewer(null);
      v.destroy();
    };
  }, [info]);

  // --- view state from the store ---
  useEffect(() => {
    viewer?.viewport.setRotation(rotation);
  }, [viewer, rotation]);

  useEffect(() => {
    if (!viewer || !info || z === shownZ.current) return;
    shownZ.current = z;
    // swap the tiled image for the new focal plane, keeping the viewport
    viewer.addTiledImage({ tileSource: tileSourceFor(info, z), index: 0, replace: true } as unknown as Parameters<OpenSeadragon.Viewer["addTiledImage"]>[0]);
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
      coords: viewer && info && hostRef.current ? makeCoords(viewer, info, hostRef.current) : null,
      onFrame,
    }),
    [viewer, info, onFrame],
  );

  return (
    <ViewerContext.Provider value={ctx}>
      <div className="viewer-wrap">
        <div ref={hostRef} className="viewer-host" />
        {viewer && (
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
