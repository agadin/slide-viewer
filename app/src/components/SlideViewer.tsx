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
import { isTilted, useStore } from "../lib/store";
import { useViewerSettings } from "../lib/a11y"; // a11y(visual): was useSettings((s) => s.s.viewer)
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
import { fitVisible, setActiveViewer } from "./viewer/viewerHandle";
import { makeCoords } from "./viewer/makeCoords";
import "./viewer/viewer.css";
import { basename } from "../lib/backend";
import { KEY_HINT, slideFacts, spokenZoom } from "../lib/announce";

const DESC_ID = "sv-viewer-desc";

/** a11y(semantics): OSD's focusable canvas element is the keyboard "application"; its drawing canvases are decorative */
function labelViewerElement(v: OpenSeadragon.Viewer, info: SlideInfo) {
  const el = (v as unknown as { canvas?: HTMLElement }).canvas;
  if (!el) return;
  el.setAttribute("role", "application");
  el.setAttribute("aria-roledescription", "slide viewer");
  el.setAttribute("aria-label", `Slide ${basename(info.path)}`);
  el.setAttribute("aria-describedby", DESC_ID);
}
function hideCanvases(root: HTMLElement) {
  for (const c of Array.from(root.querySelectorAll("canvas:not([aria-hidden])"))) c.setAttribute("aria-hidden", "true");
}

/** a11y(semantics): the viewer's description (slide, size, calibration, magnification, annotations, keys) */
function ViewerDescription({ info }: { info: SlideInfo }) {
  const zoom = useStore((s) => spokenZoom(s.slide.info, s.view.magnification, s.view.umPerScreenPx));
  const count = useStore((s) => s.annotations.items.length);
  return (
    <div id={DESC_ID} className="sr-only">
      {basename(info.path)}. {slideFacts(info)}. {zoom ? `Current ${zoom}. ` : ""}
      {count === 1 ? "1 annotation" : `${count} annotations`}, listed in the Annotations tab. {KEY_HINT}
    </div>
  );
}

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
  const vs = useViewerSettings(); // a11y(visual): animate is off while Reduce motion is on

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
      // opening / closing the side panels must not rescale the slide: by default OSD multiplies the
      // zoom by the change in the viewer's diagonal, so the image (and the magnification) jumped
      preserveImageSizeOnResize: true,
      minZoomImageRatio: 0.5,
      visibilityRatio: 0.2,
      imageLoaderLimit: 12,
      maxImageCacheCount: 256,
      degrees: useStore.getState().view.rotation,
      // Drag-to-pan must track the pointer 1:1. OSD's onCanvasDrag calls
      // panBy(delta, immediately = flickEnabled && !constrainDuringPan); with flick off (the mouse
      // default) every move goes through the 0.35 s spring and the image floats/drifts behind the
      // cursor. Enabling flick makes the pan immediate; an unreachable flickMinSpeed means release
      // never throws the image either. Zoom and goTo keep their spring animation.
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: s.dblClickZoom, scrollToZoom: true, flickEnabled: true, flickMinSpeed: Infinity },
      gestureSettingsPen: { flickEnabled: true, flickMinSpeed: Infinity },
      zoomPerScroll: s.zoomPerScroll,
      ...filterViewerOptions,
      tileSources: tileSourceFor(info, zRef.current),
    } as OpenSeadragon.Options);

    // Resize in the same frame the layout changes. OSD 6 learns about size changes from a ResizeObserver,
    // whose callback runs AFTER OSD's requestAnimationFrame update, so for at least one painted frame
    // (longer when WebKit delays the callback) the old canvas bitmap was shown stretched to the new
    // width: opening/closing the Slides or Image panel visibly squashed the slide. Polling the container
    // size inside OSD's own update (one cheap read per frame) resizes and redraws before the paint.
    (v as unknown as { _autoResizePolling: boolean })._autoResizePolling = true;
    (v as unknown as { _resizeObserver?: ResizeObserver })._resizeObserver?.disconnect();

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
    // the first view of a slide: fitted to the uncovered area, not under the panels
    v.addHandler("open", () => fitVisible(v, info));
    v.addHandler("open-failed", (e: { message?: string }) => {
      useStore.getState().setUi({ toast: { text: `Could not show the slide: ${e.message ?? "unknown error"}`, kind: "error" } });
    });

    // right-click never pans: it only opens the menu (AnnotationLayer); panning is the left drag

    labelViewerElement(v, info);
    hideCanvases(host);

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
    // Fit: the whole slide inside the part the side panels don't cover
    if (homeNonce && viewer && info) fitVisible(viewer, info);
  }, [viewer, homeNonce]); // eslint-disable-line react-hooks/exhaustive-deps -- info changes recreate the viewer

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

  // a11y(semantics): canvases added later (drawer swaps, the annotation overlay) are decorative too
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof MutationObserver === "undefined") return;
    hideCanvases(wrap);
    const mo = new MutationObserver(() => hideCanvases(wrap));
    mo.observe(wrap, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

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

  const tiltX = useStore((st) => st.view.tiltX);
  const tiltY = useStore((st) => st.view.tiltY);
  const tilted = isTilted({ tiltX, tiltY });

  return (
    <ViewerContext.Provider value={ctx}>
      <div
        ref={wrapRef}
        className={`viewer-wrap ${tilted ? "tilted" : ""}`}
        style={tilted ? ({ "--tilt-x": `${tiltX}deg`, "--tilt-y": `${tiltY}deg` } as React.CSSProperties) : undefined}
        role="region" aria-label={info ? `Slide viewer: ${basename(info.path)}` : "Slide viewer"}>
        <div ref={hostRef} className="viewer-host" />
        {viewer && info && (
          <>
            <ViewerDescription info={info} />
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
