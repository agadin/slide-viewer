/**
 * Overview map (top-left): the whole slide, rotated like the view, with the visible area outlined
 * and annotation pins as dots. Click or drag on it to move the view; scroll on it to zoom.
 * Owner: viewer (CONTRACTS.md). Shown when settings.viewer.showNavigator is on.
 *
 * The overview image comes from the backend (`slideOverview`, JPEG, ≤ 512 px) and is held as a blob
 * URL that is revoked when the slide or plane changes, so it doesn't accumulate.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import OpenSeadragon from "openseadragon";
import { useViewer, useViewerFrame } from "../../lib/viewerContext";
import { useStore } from "../../lib/store";
import { useSettings } from "../../lib/settings";
import { slideOverview } from "../../lib/backend";
import { imageFromNav, navFromImage, navLayout, type NavLayout } from "./viewMath";
import type { Pt } from "../../lib/coords";

const MAX_W = 200;
const MAX_H = 170;

export function Navigator() {
  const { viewer, info, coords, host } = useViewer();
  const show = useSettings((s) => s.s.viewer.showNavigator);
  const rotation = useStore((s) => s.view.rotation);
  const z = useStore((s) => s.view.z);
  const items = useStore((s) => s.annotations.items);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [dragging, setDragging] = useState(false);

  // overview image for this slide / plane
  useEffect(() => {
    if (!info || !show) return;
    let url: string | null = null;
    let alive = true;
    slideOverview(info.id, 512, z, "jpeg")
      .then((bytes) => {
        if (!alive) return;
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
        const im = new Image();
        im.onload = () => alive && setImg(im);
        im.src = url;
      })
      .catch(() => alive && setImg(null));
    return () => {
      alive = false;
      setImg(null);
      if (url) URL.revokeObjectURL(url);
    };
  }, [info, z, show]);

  const layoutRef = useRef<NavLayout | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !info || !coords || !viewer || !host) return;
    // follow the animated rotation so the map turns with the view
    const rot = viewer.viewport.getRotation(true);
    const L = navLayout(info.width, info.height, rot, MAX_W, MAX_H);
    layoutRef.current = L;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(L.width * dpr), H = Math.round(L.height * dpr);
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    c.style.width = `${L.width}px`;
    c.style.height = `${L.height}px`;
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
    ctx.fillStyle = "rgba(232,178,90,0.12)";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#e8b25a";
    ctx.stroke();
  }, [info, coords, viewer, host, img]);

  useViewerFrame(draw);
  useEffect(draw, [draw, items, rotation]);

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

  if (!viewer || !info || !show) return null;
  return (
    <div className={`sv-nav sv-glass ${dragging ? "dragging" : ""}`} title="Overview: click or drag to move, scroll to zoom">
      <canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel} />
    </div>
  );
}
