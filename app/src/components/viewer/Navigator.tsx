/**
 * Overview map (top-left): the whole slide, rotated like the view, with the visible area outlined
 * and annotation pins as dots. Click or drag on it to move the view; scroll on it to zoom.
 * Owner: viewer (CONTRACTS.md). Shown when settings.viewer.showNavigator is on.
 *
 * The overview image comes from the backend (`slideOverview`, JPEG, ≤ 512 px). It is fetched when the
 * slide opens (even while the map is hidden) and cached per slide + plane, and the map stays mounted
 * while hidden (M), so showing it again is instant: no blank card at the default canvas size that
 * then shrinks once the image arrives.
 *
 * The card can be moved (drag its top grip) and resized (drag its bottom-right corner); both are
 * remembered in settings.viewer.navPos / navSize. Double-click the grip to put it back.
 */
import { planeKey } from "../../lib/types";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import OpenSeadragon from "openseadragon";
import { useViewer, useViewerFrame } from "../../lib/viewerContext";
import { useStore } from "../../lib/store";
import { useSettings } from "../../lib/settings";
import { slideOverview } from "../../lib/backend";
import { imageFromNav, navFromImage, navLayout, type NavLayout } from "./viewMath";
import type { Pt } from "../../lib/coords";

export const NAV_MIN = 120;
export const NAV_MAX = 520;
export const NAV_DEFAULT_POS = { x: 12, y: 12 };
const clampSize = (n: number) => Math.round(Math.min(NAV_MAX, Math.max(NAV_MIN, n || 200)));

/** overview images per "slideId:z"; dropped when another slide opens */
const overviews = new Map<string, { img: HTMLImageElement; url: string }>();
let overviewsFor: number | null = null;
function forgetOverviews(keepSlide: number) {
  if (overviewsFor === keepSlide) return;
  for (const v of overviews.values()) URL.revokeObjectURL(v.url);
  overviews.clear();
  overviewsFor = keepSlide;
}

export function Navigator() {
  const { viewer, info, coords, host } = useViewer();
  const show = useSettings((s) => s.s.viewer.showNavigator);
  const savedSize = useSettings((s) => s.s.viewer.navSize);
  const savedPos = useSettings((s) => s.s.viewer.navPos);
  const setViewer = useSettings((s) => s.setSection);
  // live values while dragging the grip / corner (committed to settings on release)
  const [livePos, setLivePos] = useState<{ x: number; y: number } | null>(null);
  const [liveSize, setLiveSize] = useState<number | null>(null);
  const size = clampSize(liveSize ?? savedSize);
  const pos = livePos ?? savedPos ?? NAV_DEFAULT_POS;
  const cardRef = useRef<HTMLDivElement>(null);
  const rotation = useStore((s) => s.view.rotation);
  const z = useStore((s) => planeKey(s.view.z, s.view.t));
  const items = useStore((s) => s.annotations.items);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [dragging, setDragging] = useState(false);

  // overview image for this slide / plane: fetched once, cached, independent of whether the map shows
  useEffect(() => {
    if (!info) return;
    forgetOverviews(info.id);
    const key = `${info.id}:${z}`;
    const hit = overviews.get(key);
    if (hit) {
      setImg(hit.img);
      return;
    }
    let alive = true;
    slideOverview(info.id, 512, z, "jpeg")
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
        const im = new Image();
        im.onload = () => {
          if (overviewsFor === info.id) overviews.set(key, { img: im, url });
          else URL.revokeObjectURL(url);
          if (alive) setImg(im);
        };
        im.src = url;
      })
      .catch(() => alive && setImg(null));
    return () => {
      alive = false;
    };
  }, [info, z]);

  const layoutRef = useRef<NavLayout | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !info || !coords || !viewer || !host || !show) return;
    // follow the animated rotation so the map turns with the view
    const rot = viewer.viewport.getRotation(true);
    const L = navLayout(info.width, info.height, rot, size, Math.round(size * 0.85));
    layoutRef.current = L;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(L.width * dpr), H = Math.round(L.height * dpr);
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    c.style.width = `${L.width}px`;
    c.style.height = `${L.height}px`;
    // lets a top-left scale bar sit just under the map (viewer.css .sv-scalebar.at-top-left.below-map)
    // (--nav-h is measured from the default top: 12px, so a moved map still pushes it below)
    c.closest<HTMLElement>(".viewer-wrap")?.style.setProperty("--nav-h", `${Math.max(0, pos.y - 12) + L.height}px`);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, L.width, L.height);
    // the slide
    ctx.save();
    ctx.translate(L.width / 2, L.height / 2);
    ctx.rotate((L.rotation * Math.PI) / 180);
    const sw = info.width * L.scale, sh = info.height * L.scale;
    if (img) ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);
    else {
      ctx.fillStyle = "rgba(240,236,240,0.85)";
      ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
    }
    ctx.restore();
    // pins
    ctx.fillStyle = "#00ff00";
    for (const a of itemsRef.current) {
      if (!a.points.length) continue;
      const p = navFromImage(L, coords.nmToImage(a.points[0]));
      ctx.fillStyle = a.color || "#00ff00";
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
    // the visible area
    const r = host.getBoundingClientRect();
    const corners: Pt[] = [
      { x: 0, y: 0 },
      { x: r.width, y: 0 },
      { x: r.width, y: r.height },
      { x: 0, y: r.height },
    ].map((p) => navFromImage(L, coords.screenToImage(p)));
    ctx.beginPath();
    corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = "rgba(140,200,255,0.14)";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#8cc8ff";
    ctx.stroke();
  }, [info, coords, viewer, host, img, show, size, pos.y]);

  useViewerFrame(draw);
  // layout effect: the canvas gets its real size before the browser paints (no 300×150 flash)
  useLayoutEffect(draw, [draw, items, rotation]);

  // ---- move (drag the grip) and resize (drag the corner); clamped to the slide area
  const wrapRect = () => cardRef.current?.parentElement?.getBoundingClientRect() ?? null;
  const clampPos = (x: number, y: number) => {
    const r = wrapRect(), card = cardRef.current?.getBoundingClientRect();
    if (!r || !card) return { x, y };
    return { x: Math.round(Math.min(Math.max(0, x), r.width - card.width)), y: Math.round(Math.min(Math.max(0, y), r.height - card.height)) };
  };
  const startDrag = (e: React.PointerEvent, kind: "move" | "resize") => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY;
    const p0 = pos, s0 = size;
    let last: { pos?: { x: number; y: number }; size?: number } = {};
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (kind === "move") {
        last = { pos: clampPos(p0.x + dx, p0.y + dy) };
        setLivePos(last.pos!);
      } else {
        last = { size: clampSize(s0 + Math.max(dx, dy / 0.85)) };
        setLiveSize(last.size!);
      }
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (last.pos) setViewer("viewer", { navPos: last.pos });
      if (last.size) setViewer("viewer", { navSize: last.size });
      setLivePos(null);
      setLiveSize(null);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const resetCard = () => setViewer("viewer", { navPos: null, navSize: 200 });

  // keep a moved map inside the slide area when the window shrinks
  useEffect(() => {
    if (!savedPos) return;
    const fix = () => {
      const c = clampPos(savedPos.x, savedPos.y);
      if (c.x !== savedPos.x || c.y !== savedPos.y) setViewer("viewer", { navPos: c });
    };
    window.addEventListener("resize", fix);
    return () => window.removeEventListener("resize", fix);
  });

  // click / drag: centre the view on the point
  const moveTo = (e: React.PointerEvent, immediately: boolean) => {
    const c = canvasRef.current, L = layoutRef.current;
    if (!c || !L || !viewer || !info) return;
    const r = c.getBoundingClientRect();
    const ip = imageFromNav(L, { x: e.clientX - r.left, y: e.clientY - r.top });
    const x = Math.min(Math.max(ip.x, 0), info.width), y = Math.min(Math.max(ip.y, 0), info.height);
    viewer.viewport.panTo(new OpenSeadragon.Point(x / info.width, y / info.width), immediately);
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
    moveTo(e, false);
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragging) moveTo(e, true);
  };
  const onUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!viewer) return;
    viewer.viewport.zoomBy(e.deltaY < 0 ? 1.25 : 0.8);
  };

  if (!viewer || !info) return null;
  return (
    <div
      ref={cardRef}
      // hidden, not unmounted, when the map is off (M): showing it again is instant
      hidden={!show}
      // measured from the uncovered area's left edge: the Slides panel floats over the slide
      style={{ left: `calc(var(--side-w, 0px) + ${pos.x}px)`, top: pos.y }}
      className={`sv-nav ${dragging ? "dragging" : ""} ${img ? "" : "loading"} ${livePos || liveSize ? "adjusting" : ""}`}
      title="Overview: click or drag to move, scroll to zoom"
      role="img"
      aria-label="Overview map of the whole slide. The outlined box is the part on screen; dots are annotations. Press M to hide it."
    >
      <canvas ref={canvasRef} aria-hidden onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel} />
      <div className="sv-nav-grip" title="Drag to move the map · double-click to put it back" aria-hidden onPointerDown={(e) => startDrag(e, "move")} onDoubleClick={resetCard} />
      <div className="sv-nav-resize" title="Drag to resize the map · double-click for the default size" aria-hidden onPointerDown={(e) => startDrag(e, "resize")} onDoubleClick={resetCard} />
    </div>
  );
}
