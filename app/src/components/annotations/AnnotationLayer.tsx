/**
 * Annotations over the slide: drawing, the drawing tools and editing. Owner: annotations (CONTRACTS.md).
 *
 * Mounted inside the viewer by SlideViewer.tsx. Input goes through OpenSeadragon's own canvas events
 * (press / drag / release / click / double-click), so the scroll wheel always zooms and a drag that isn't
 * ours still pans. We set `preventDefaultAction` only on the gestures we use.
 *
 * Tools (store annotations.tool):
 *  - pan (V): click selects (⇧ adds), drag a pin / outline / selected shape to move it, drag a handle to
 *    reshape, double-click renames, right-click for a menu.
 *  - pin (P): click places a pin and opens its title editor (free text); a drag still pans.
 *  - ruler (R): drag measures (live µm / mm, px when uncalibrated); release saves a linear annotation; Esc cancels.
 *  - freehand (F): drag to draw a closed outline, or click points and double-click (or ↵, or click the
 *    first point) to close; ⌫ removes the last point.
 *  - circle (C): drag out the radius from the centre.  - rectangle (B): drag corner to corner.
 * Handles of the selected shape can be dragged in every tool. Keys: ⌫/Delete deletes the selection,
 * ↵ renames, Esc cancels a drawing (then clears the selection, then keys.ts returns to Pan).
 * All geometry is stored in nm; the screen conversions come from the viewer context, so rotation just works.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type OpenSeadragon from "openseadragon";
import { useViewer, useViewerFrame } from "../../lib/viewerContext";
import { useStore } from "../../lib/store";
import { useSettings } from "../../lib/settings";
import type { Pt } from "../../lib/coords";
import type { Annotation, PtNm } from "../../lib/types";
import {
  addAnnotation,
  boundsNm,
  deleteAnnotations,
  editable,
  hitTest,
  makeAnnotation,
  measureText,
  moveBy,
  paintAnnotations,
  rectFrom,
  renameAnnotation,
  replaceAnnotation,
  updateAnnotation,
  useAnnUi,
  withVertex,
  drawLabel,
  pinHead,
  PIN_SIZE,
  type Hit,
} from "../../lib/annotations";
import { PIN_COLORS } from "../../lib/ndpa";
import { dist } from "../../lib/measure";
import "./annotations.css";

type OsdEvent = { position: OpenSeadragon.Point; originalEvent: Event; preventDefaultAction: boolean; quick?: boolean; shift?: boolean };

/** what the pointer is doing right now */
type Gesture =
  | { mode: "draw"; tool: "ruler" | "circle" | "rectangle" | "freehand"; startScreen: Pt; start: PtNm; a: Annotation | null; pts: PtNm[]; last: Pt }
  | { mode: "poly"; pts: PtNm[]; hover: PtNm | null; skipClick: boolean }
  | { mode: "move"; id: string; startScreen: Pt; start: PtNm; orig: Annotation; preview: Annotation | null; select: boolean; shift: boolean }
  | { mode: "vertex"; id: string; index: number; orig: Annotation; fixed: PtNm | null; preview: Annotation | null }
  | { mode: "radius"; id: string; orig: Annotation; preview: Annotation | null };

const DRAG_MIN = 4; // screen px before a press counts as a drag
const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

export function AnnotationLayer() {
  const { viewer, info, coords } = useViewer();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  const items = useStore((s) => s.annotations.items);
  const selection = useStore((s) => s.annotations.selection);
  const tool = useStore((s) => s.annotations.tool);
  const editingId = useStore((s) => s.annotations.editingId);
  const hidden = useAnnUi((s) => s.hidden);
  const jump = useAnnUi((s) => s.jump);
  const showTitles = useSettings((s) => s.s.annotations.showTitles);

  // ---------------------------------------------------------------- painting
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !coords || !viewer) return;
    const host = viewer.element;
    const w = host.clientWidth, h = host.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const st = useStore.getState();
    const g = gesture.current;
    let list: Annotation[] = st.annotations.items;
    const preview = g && (g.mode === "move" || g.mode === "vertex" || g.mode === "radius") ? g.preview : null;
    if (preview) list = list.map((a) => (a.id === preview.id ? preview : a));
    if (g?.mode === "draw" && g.a) list = [...list, g.a];
    const sel = new Set(st.annotations.selection);
    if (g?.mode === "draw" && g.a) sel.add(g.a.id);
    const calibrated = st.slide.info?.calibrated ?? true;
    paintAnnotations(ctx, coords, list, {
      selection: sel,
      showTitles: useSettings.getState().s.annotations.showTitles,
      scale: dpr,
      hidden: new Set(useAnnUi.getState().hidden),
      calibrated,
      editingId: st.annotations.editingId,
    });
    if (g?.mode === "poly" && g.pts.length) {
      // click-by-click outline in progress, with a rubber band to the pointer
      const color = useSettings.getState().s.annotations.defaultColor;
      const pts = g.hover ? [...g.pts, g.hover] : g.pts;
      const s = pts.map((p) => coords.nmToScreen(p));
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.beginPath();
      s.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const p of s.slice(0, g.pts.length)) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
      }
      const first = s[0];
      ctx.beginPath();
      ctx.arc(first.x, first.y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (g.pts.length >= 3) {
        const m = measureText({ kind: "freehand", points: pts, closed: true }, calibrated);
        const last = s[s.length - 1];
        if (m) drawLabel(ctx, last.x + 12, last.y + 14, [m, "double-click or ↵ to close"]);
      }
      ctx.restore();
    }
    // keep the inline title editor on its annotation
    const ed = editorRef.current;
    const editing = st.annotations.items.find((a) => a.id === st.annotations.editingId);
    if (ed && editing) {
      const s = coords.nmToScreen(editing.points[0]);
      const at = editing.kind === "pin" ? pinHead(s) : s;
      ed.style.left = `${at.x + (editing.kind === "pin" ? PIN_SIZE * 0.45 : 8)}px`;
      ed.style.top = `${at.y - 13}px`;
    }
  }, [coords, viewer]);

  useViewerFrame(draw);
  useEffect(draw, [draw, items, selection, hidden, showTitles, editingId, tool]);

  // ---------------------------------------------------------------- helpers
  const cancelGesture = useCallback(() => {
    if (!gesture.current) return false;
    gesture.current = null;
    draw();
    rerender();
    return true;
  }, [draw]);

  const newItem = useCallback(
    (kind: Annotation["kind"], points: PtNm[], extra: { radiusNm?: number; closed?: boolean } = {}) => {
      const st = useStore.getState();
      return makeAnnotation(kind, points, {
        color: useSettings.getState().s.annotations.defaultColor,
        items: st.annotations.items,
        doc: st.annotations.doc,
        lens: st.view.magnification,
        z: st.view.z,
        ...extra,
      });
    },
    [],
  );

  const finishPoly = useCallback(() => {
    const g = gesture.current;
    if (g?.mode !== "poly" || !coords) return;
    // a double-click also clicked twice: drop points that landed on the one before
    const pts: PtNm[] = [];
    for (const p of g.pts) {
      const prev = pts[pts.length - 1];
      if (!prev || dist(coords.nmToScreen(prev), coords.nmToScreen(p)) > DRAG_MIN) pts.push(p);
    }
    gesture.current = null;
    if (pts.length >= 3) addAnnotation(newItem("freehand", pts, { closed: true }));
    draw();
    rerender();
  }, [coords, draw, newItem]);

  // a removed annotation (undo, delete) can't stay in a gesture
  useEffect(() => {
    const g = gesture.current;
    if (g && "id" in g && !items.some((a) => a.id === g.id)) cancelGesture();
  }, [items, cancelGesture]);
  // switching tools drops a half-drawn shape
  useEffect(() => {
    const g = gesture.current;
    if (g && (g.mode === "draw" || g.mode === "poly")) cancelGesture();
  }, [tool, cancelGesture]);

  // ---------------------------------------------------------------- pointer input (OSD canvas events)
  useEffect(() => {
    if (!viewer || !coords) return;
    const st = () => useStore.getState();
    const pos = (e: OsdEvent): Pt => ({ x: e.position.x, y: e.position.y });
    const isPrimary = (e: OsdEvent) => !(e.originalEvent instanceof MouseEvent) || e.originalEvent.button === 0;
    const hit = (p: Pt): Hit | null =>
      hitTest(coords, st().annotations.items, p, { selection: st().annotations.selection, hidden: useAnnUi.getState().hidden });
    const byId = (id: string) => st().annotations.items.find((a) => a.id === id);

    const onPress = (e: OsdEvent) => {
      if (!isPrimary(e)) return;
      const p = pos(e);
      const s = st();
      const tool = s.annotations.tool;
      const g = gesture.current;
      if (g?.mode === "poly") return; // points are added on click
      // clicking away from the title editor keeps what was typed (blur commits it)
      if (s.annotations.editingId) editorRef.current?.blur();
      const h = hit(p);
      const a = h ? byId(h.id) : undefined;
      if (h && a && h.part === "handle" && h.handle && editable(a)) {
        if (h.handle.kind === "radius") gesture.current = { mode: "radius", id: a.id, orig: a, preview: null };
        else
          gesture.current = {
            mode: "vertex",
            id: a.id,
            index: h.handle.index,
            orig: a,
            fixed: a.kind === "rectangle" ? a.points[(h.handle.index + 2) % 4] : null,
            preview: null,
          };
        return;
      }
      const sel = s.annotations.selection;
      if (tool === "pan" || tool === "pin") {
        // pins and outlines move straight away; a shape's interior only once it's selected (else the drag pans)
        if (h && a && editable(a) && (h.part === "edge" || sel.includes(a.id)))
          gesture.current = { mode: "move", id: a.id, startScreen: p, start: coords.screenToNm(p), orig: a, preview: null, select: !sel.includes(a.id), shift: !!e.shift };
        return;
      }
      const start = coords.screenToNm(p);
      gesture.current = { mode: "draw", tool, startScreen: p, start, a: null, pts: [start], last: p };
    };

    const onDrag = (e: OsdEvent) => {
      const g = gesture.current;
      if (!g || g.mode === "poly") return;
      e.preventDefaultAction = true;
      const p = pos(e);
      const nm = coords.screenToNm(p);
      if (g.mode === "draw") {
        if (dist(p, g.startScreen) < DRAG_MIN && !g.a) return;
        if (g.tool === "ruler") g.a = { ...(g.a ?? newItem("ruler", [g.start, nm])), points: [g.start, nm].map(roundPt) };
        else if (g.tool === "circle") {
          const r = Math.round(dist(g.start, nm));
          g.a = { ...(g.a ?? newItem("circle", [g.start], { radiusNm: r })), radiusNm: r };
        } else if (g.tool === "rectangle") g.a = { ...(g.a ?? newItem("rectangle", rectFrom(g.start, nm))), points: rectFrom(g.start, nm) };
        else {
          if (dist(p, g.last) >= 3) {
            g.pts.push(nm);
            g.last = p;
          }
          g.a = { ...(g.a ?? newItem("freehand", g.pts, { closed: false })), points: g.pts.map(roundPt), closed: false };
        }
      } else if (g.mode === "move") {
        if (!g.preview && dist(p, g.startScreen) < DRAG_MIN) return;
        g.preview = moveBy(g.orig, nm.x - g.start.x, nm.y - g.start.y);
      } else if (g.mode === "vertex") {
        g.preview = g.fixed ? { ...g.orig, points: rectFrom(g.fixed, nm) } : withVertex(g.orig, g.index, nm);
      } else if (g.mode === "radius") {
        g.preview = { ...g.orig, radiusNm: Math.max(1, Math.round(dist(g.orig.points[0], nm))) };
      }
      draw();
    };

    const onRelease = () => {
      const g = gesture.current;
      if (!g || g.mode === "poly") return;
      gesture.current = null;
      if (g.mode === "draw") {
        if (g.tool === "freehand" && !g.a) {
          // a click, not a drag: start a click-by-click outline
          gesture.current = { mode: "poly", pts: [g.start], hover: null, skipClick: true };
        } else if (g.a) {
          let a = g.a;
          if (a.kind === "freehand") a = { ...a, closed: true };
          const big =
            a.kind === "ruler" ? dist(coords.nmToScreen(a.points[0]), coords.nmToScreen(a.points[1])) >= DRAG_MIN
            : a.kind === "circle" ? (a.radiusNm ?? 0) * coords.screenPxPerNm() >= DRAG_MIN
            : a.kind === "freehand" ? a.points.length >= 3
            : true;
          if (big) addAnnotation(a);
        }
      } else if (g.mode === "move") {
        // (a plain click on it selects in onClick)
        if (g.preview) {
          replaceAnnotation(g.preview);
          if (g.select) st().select([g.id]);
        }
      } else if (g.preview) replaceAnnotation(g.preview);
      draw();
      rerender();
    };

    const onClick = (e: OsdEvent) => {
      if (!e.quick || !isPrimary(e)) return;
      const p = pos(e);
      const g = gesture.current;
      const s = st();
      if (g?.mode === "poly") {
        e.preventDefaultAction = true;
        if (g.skipClick) {
          g.skipClick = false;
          return;
        }
        const first = coords.nmToScreen(g.pts[0]);
        if (g.pts.length >= 3 && dist(p, first) <= 8) return finishPoly();
        g.pts.push(coords.screenToNm(p));
        draw();
        return;
      }
      const tool = s.annotations.tool;
      const h = hit(p);
      if (tool === "pin" && !h) {
        e.preventDefaultAction = true;
        const a = newItem("pin", [coords.screenToNm(p)]);
        addAnnotation(a);
        s.setAnnotations({ editingId: a.id });
        return;
      }
      if (tool === "pan" || tool === "pin") {
        if (h && h.part !== "handle") {
          const sel = s.annotations.selection;
          s.select(e.shift ? (sel.includes(h.id) ? sel.filter((x) => x !== h.id) : [...sel, h.id]) : [h.id]);
        } else if (!h && !e.shift) s.select([]);
      }
    };

    const onDblClick = (e: OsdEvent) => {
      const g = gesture.current;
      if (g?.mode === "poly") {
        e.preventDefaultAction = true;
        finishPoly();
        return;
      }
      // drawing tools never double-click-zoom (it would fire while placing pins / points)
      if (st().annotations.tool !== "pan") e.preventDefaultAction = true;
      const h = hit(pos(e));
      if (h) {
        e.preventDefaultAction = true;
        st().select([h.id]);
        st().setAnnotations({ editingId: h.id });
      }
    };

    const onDragEnd = (e: OsdEvent) => {
      if (gesture.current) e.preventDefaultAction = true;
    };

    const handlers: [string, (e: OsdEvent) => void][] = [
      ["canvas-press", onPress],
      ["canvas-drag", onDrag],
      ["canvas-drag-end", onDragEnd],
      ["canvas-release", onRelease],
      ["canvas-click", onClick],
      ["canvas-double-click", onDblClick],
    ];
    const v = viewer as unknown as { addHandler: (n: string, f: (e: OsdEvent) => void) => void; removeHandler: (n: string, f: (e: OsdEvent) => void) => void };
    for (const [n, f] of handlers) v.addHandler(n, f);

    // hover: cursor feedback and the click-by-click rubber band
    const el = viewer.element;
    const onMove = (e: PointerEvent) => {
      const p = coords.eventToScreen(e);
      const g = gesture.current;
      if (g?.mode === "poly") {
        g.hover = coords.screenToNm(p);
        draw();
      }
      const tool = st().annotations.tool;
      const h = g ? null : hit(p);
      viewer.canvas.style.cursor = h?.part === "handle" ? "crosshair" : h && (h.part === "edge" || st().annotations.selection.includes(h.id)) ? "move" : tool === "pan" ? "" : tool === "pin" ? "copy" : "crosshair";
    };
    // right-click: the annotation's menu
    const onContext = (e: MouseEvent) => {
      const h = hit(coords.eventToScreen(e));
      if (!h) return;
      e.preventDefault();
      const s = st();
      if (!s.annotations.selection.includes(h.id)) s.select([h.id]);
      const ids = s.annotations.selection.includes(h.id) ? s.annotations.selection : [h.id];
      const a = byId(h.id);
      if (!a) return;
      s.setUi({
        menu: {
          x: e.clientX,
          y: e.clientY,
          items: [
            { label: "Rename…", shortcut: "↵", onSelect: () => st().setAnnotations({ editingId: a.id }) },
            "sep",
            ...PIN_COLORS.map((c) => ({ label: `${a.color === c.hex ? "● " : "○ "}${c.name[0].toUpperCase()}${c.name.slice(1)}`, onSelect: () => updateAnnotation(a.id, { color: c.hex }) })),
            "sep" as const,
            { label: ids.length > 1 ? `Delete ${ids.length} annotations` : "Delete", shortcut: "⌫", danger: true, onSelect: () => deleteAnnotations(ids) },
          ],
        },
      });
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("contextmenu", onContext);
    return () => {
      for (const [n, f] of handlers) v.removeHandler(n, f);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("contextmenu", onContext);
      viewer.canvas.style.cursor = "";
    };
  }, [viewer, coords, draw, newItem, finishPoly]);

  // ---------------------------------------------------------------- keys (capture: before lib/keys.ts)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target) || useStore.getState().ui.menu) return;
      if (e.metaKey || e.ctrlKey || e.altKey) {
        // undo / redo mid-gesture: drop the gesture first
        if (e.key.toLowerCase() === "z") cancelGesture();
        return;
      }
      const s = useStore.getState();
      const g = gesture.current;
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "Escape") {
        if (cancelGesture()) return consume();
        if (s.annotations.selection.length) {
          s.select([]);
          return consume();
        }
        return;
      }
      if (g?.mode === "poly") {
        if (e.key === "Enter") {
          consume();
          return finishPoly();
        }
        if (e.key === "Backspace" || e.key === "Delete") {
          consume();
          g.pts.pop();
          if (!g.pts.length) gesture.current = null;
          draw();
          return;
        }
      }
      if ((e.key === "Delete" || e.key === "Backspace") && s.annotations.selection.length) {
        consume();
        deleteAnnotations(s.annotations.selection);
        return;
      }
      if (e.key === "Enter" && s.annotations.selection.length === 1) {
        consume();
        s.setAnnotations({ editingId: s.annotations.selection[0] });
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [cancelGesture, finishPoly, draw]);

  // ---------------------------------------------------------------- "show me" from the annotation list
  useEffect(() => {
    if (!jump || !viewer || !info || !coords) return;
    const a = useStore.getState().annotations.items.find((x) => x.id === jump.id);
    const item = viewer.world.getItemAt(0);
    if (!a || !item) return;
    const b = boundsNm(a);
    const p0 = coords.nmToImage({ x: b.x0, y: b.y0 }), p1 = coords.nmToImage({ x: b.x1, y: b.y1 });
    const cx = (p0.x + p1.x) / 2, cy = (p0.y + p1.y) / 2;
    // at least the size of the screen at 10× (pins), and the shape with a margin
    const screenW = viewer.element.clientWidth || 800, screenH = viewer.element.clientHeight || 600;
    const um = useStore.getState().view.umPerScreenPx ?? 1;
    const atMost = Math.min(um, 1) / info.mppX; // image px per screen px: no further out than 10× for a point
    const w = Math.max(Math.abs(p1.x - p0.x) * 1.6, a.kind === "pin" ? screenW * atMost : 0, 64);
    const h = Math.max(Math.abs(p1.y - p0.y) * 1.6, a.kind === "pin" ? screenH * atMost : 0, 64);
    viewer.viewport.fitBounds(item.imageToViewportRectangle(cx - w / 2, cy - h / 2, w, h));
  }, [jump, viewer, info, coords]);

  // ---------------------------------------------------------------- inline title editor
  const editing = items.find((a) => a.id === editingId) ?? null;
  return (
    <>
      <canvas ref={canvasRef} className="ann-canvas" aria-hidden />
      {editing && (
        <TitleEditor
          key={editing.id}
          inputRef={editorRef}
          initial={editing.title}
          onDone={(title) => {
            useStore.getState().setAnnotations({ editingId: null });
            if (title !== null && title.trim() !== editing.title) renameAnnotation(editing.id, title);
          }}
          onMount={draw}
        />
      )}
    </>
  );
}

const roundPt = (p: PtNm): PtNm => ({ x: Math.round(p.x), y: Math.round(p.y) });

function TitleEditor(p: { initial: string; inputRef: RefObject<HTMLInputElement | null>; onDone: (t: string | null) => void; onMount: () => void }) {
  const done = useRef(false);
  const finish = (t: string | null) => {
    if (done.current) return;
    done.current = true;
    p.onDone(t);
  };
  useEffect(() => {
    p.onMount();
    const el = p.inputRef.current;
    el?.focus();
    el?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <input
      ref={p.inputRef}
      className="ann-title-editor"
      defaultValue={p.initial}
      spellCheck={false}
      placeholder="Title"
      aria-label="Annotation title"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
