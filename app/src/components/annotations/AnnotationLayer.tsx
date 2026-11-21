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
 *
 * Keyboard operation (a11y, WCAG 2.1.1): everything above works without a mouse too.
 *  - X (lib/keys.ts) or ↵ on the focused slide turns on the keyboard cursor: a cross-hair fixed at the
 *    centre of the view. The arrows pan the slide under it (⇧ for bigger steps; keys.ts).
 *  - Space = a click at the cursor (select / place a pin / set a point); ↵ = Space for the drawing tools,
 *    and the right-click menu at the cursor with the Pan tool. P / ⇧P drop a pin / flag at the cursor.
 *  - Ruler, circle, rectangle: Space (or ↵) sets the first point, pan, Space sets the second; the shape
 *    follows the cursor in between. Freehand: Space per point, ⇧↵ (or Space on the first point) closes.
 *  - N / ⇧N (keys.ts) step through the annotations and show each; ⌥ arrows move the selection (⌥⇧ bigger);
 *    F2 renames; ⇧F10 or the Menu key opens the menu of the selection, or the slide menu at the cursor
 *    (or the view centre): rename, style, colour, delete, add pin / flag, shapes, zoom, rotate.
 *  - The slide (OSD's canvas) is in the tab order with a focus ring drawn here; Tab always leaves it and
 *    Esc steps back (drawing → selection → tool → cursor off). Mouse input is unchanged.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type OpenSeadragon from "openseadragon";
import { useViewer, useViewerFrame } from "../../lib/viewerContext";
import { isTilted, useStore } from "../../lib/store";
import { zoomItems } from "./viewerMenu";
import { useSettings } from "../../lib/settings";
import type { Pt } from "../../lib/coords";
import type { Annotation, PinStyle, PtNm } from "../../lib/types";
import { annotationMenu, slideMenu } from "./viewerMenu";
import { characterKeyBlocked, focusOnSlide } from "../../lib/keys";
import { announce, describeAnnotation } from "../../lib/announce";
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
  anchorOf,
  KB_NUDGE_BIG_PX,
  KB_NUDGE_PX,
  KIND_LABEL,
  nudgeSelection,
  setKbCursor,
  shapeFromPoints,
} from "../../lib/annotations";
import { dist } from "../../lib/measure";
import "./annotations.css";

type OsdEvent = { position: OpenSeadragon.Point; originalEvent: Event; preventDefaultAction: boolean; quick?: boolean; shift?: boolean };

/** what the pointer is doing right now */
type Gesture =
  | { mode: "draw"; tool: "ruler" | "circle" | "rectangle" | "freehand"; startScreen: Pt; start: PtNm; a: Annotation | null; pts: PtNm[]; last: Pt }
  | { mode: "poly"; pts: PtNm[]; hover: PtNm | null; skipClick: boolean; kb?: boolean }
  /** keyboard cursor: first point set, the second follows the cursor until Space / ↵ */
  | { mode: "kbdraw"; tool: "ruler" | "circle" | "rectangle"; start: PtNm; a: Annotation | null }
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

  const newItem = useCallback(
    (kind: Annotation["kind"], points: PtNm[], extra: { radiusNm?: number; closed?: boolean; color?: string; pinStyle?: PinStyle } = {}) => {
      const st = useStore.getState();
      return makeAnnotation(kind, points, {
        color: useSettings.getState().s.annotations.defaultColor,
        items: st.annotations.items,
        doc: st.annotations.doc,
        lens: st.view.magnification,
        // NDP.view's <z> is the focal offset in nm (0 = nominal focus), not our plane index
        z: Math.round(st.slide.info?.zPlanes.find((p) => p.index === st.view.z)?.offsetNm ?? 0),
        ...extra,
      });
    },
    [],
  );

  /** the focus ring on the slide: shown when the slide got the focus from the keyboard */
  const ring = useRef(false);

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
    // keyboard cursor: the view centre
    const kb = !!useAnnUi.getState().kbCursor;
    const centre: Pt = { x: w / 2, y: h / 2 };
    if (g?.mode === "kbdraw") {
      const nm = coords.screenToNm(centre);
      g.a = dist(coords.nmToScreen(g.start), centre) >= DRAG_MIN ? { ...(g.a ?? newItem(g.tool, [g.start])), ...shapeFromPoints(g.tool, g.start, nm) } : null;
    }
    if (g?.mode === "poly" && g.kb) g.hover = coords.screenToNm(centre);
    let list: Annotation[] = st.annotations.items;
    const preview = g && (g.mode === "move" || g.mode === "vertex" || g.mode === "radius") ? g.preview : null;
    if (preview) list = list.map((a) => (a.id === preview.id ? preview : a));
    if ((g?.mode === "draw" || g?.mode === "kbdraw") && g.a) list = [...list, g.a];
    const sel = new Set(st.annotations.selection);
    if ((g?.mode === "draw" || g?.mode === "kbdraw") && g.a) sel.add(g.a.id);
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
        if (m) drawLabel(ctx, last.x + 12, last.y + 14, [m, g.kb ? "⇧↵ or Space on the first point to close" : "double-click or ↵ to close"]);
      }
      ctx.restore();
    }
    if (kb || ring.current) {
      ctx.save();
      ctx.scale(dpr, dpr);
      if (ring.current) drawFocusRing(ctx, w, h);
      if (kb) {
        if (g?.mode === "kbdraw" && !g.a) drawDot(ctx, coords.nmToScreen(g.start));
        drawReticle(ctx, centre);
        drawLabel(ctx, centre.x + 18, centre.y + 22, [cursorHint(st.annotations.tool, g)]);
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
  }, [coords, viewer, newItem]);

  useViewerFrame(draw);
  const a11yLook = useSettings((s) => s.s.a11y); // a11y(visual): repaint when Preferences ▸ Accessibility changes
  useEffect(draw, [draw, items, selection, hidden, showTitles, editingId, tool, a11yLook]);

  // ---------------------------------------------------------------- helpers
  const cancelGesture = useCallback(() => {
    if (!gesture.current) return false;
    gesture.current = null;
    draw();
    rerender();
    return true;
  }, [draw]);

  /** when ⇧F10 / the Menu key last opened a menu (performance.now()) */
  const kbMenuAt = useRef(-1e9);

  /** a shape tool picked from the right-click menu is used once, then the tool goes back to Pan */
  const oneShot = useRef(false);
  const endOneShot = useCallback(() => {
    if (!oneShot.current) return;
    oneShot.current = false;
    useStore.getState().setTool("pan");
  }, []);

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
    endOneShot();
    draw();
    rerender();
  }, [coords, draw, newItem, endOneShot]);

  // a removed annotation (undo, delete) can't stay in a gesture
  useEffect(() => {
    const g = gesture.current;
    if (g && "id" in g && !items.some((a) => a.id === g.id)) cancelGesture();
  }, [items, cancelGesture]);
  // switching tools drops a half-drawn shape
  useEffect(() => {
    const g = gesture.current;
    if (g && (g.mode === "draw" || g.mode === "poly" || g.mode === "kbdraw")) cancelGesture();
  }, [tool, cancelGesture]);

  // ---------------------------------------------------------------- menus (right-click, ⇧F10)
  const placePinAt = useCallback(
    (at: PtNm, style: PinStyle, hex?: string) => {
      const a = newItem("pin", [at], hex ? { color: hex, pinStyle: style } : { pinStyle: style });
      addAnnotation(a);
      useStore.getState().setAnnotations({ editingId: a.id });
    },
    [newItem],
  );

  /** the menu of annotation `a` (acting on `ids`), at a client point */
  const openAnnotationMenu = useCallback((a: Annotation, ids: string[], client: Pt) => {
    useStore.getState().setUi({
      menu: {
        x: client.x,
        y: client.y,
        items: annotationMenu(a, ids, {
          rename: () => useStore.getState().setAnnotations({ editingId: a.id }),
          update: (patch) => updateAnnotation(a.id, patch),
          remove: () => deleteAnnotations(ids),
        }),
      },
    });
  }, []);

  /** right-click at screen point p: the annotation's menu, or (on the bare slide) the place / zoom menu (viewerMenu.ts) */
  const openMenuAt = useCallback(
    (p: Pt, client: Pt) => {
      if (!coords) return;
      const st = () => useStore.getState();
      const s = st();
      const h = gesture.current ? null : hitTest(coords, s.annotations.items, p, { selection: s.annotations.selection, hidden: useAnnUi.getState().hidden });
      if (!h) {
        const at = coords.screenToNm(p);
        s.setUi({
          menu: {
            x: client.x,
            y: client.y,
            items: slideMenu({
              placePin: (style, hex) => placePinAt(at, style, hex),
              startShape: (tool) => {
                cancelGesture();
                oneShot.current = true;
                st().setTool(tool);
              },
            }),
          },
        });
        return;
      }
      if (!s.annotations.selection.includes(h.id)) s.select([h.id]);
      const ids = st().annotations.selection.includes(h.id) ? st().annotations.selection : [h.id];
      const a = s.annotations.items.find((x) => x.id === h.id);
      if (a) openAnnotationMenu(a, ids, client);
    },
    [coords, placePinAt, cancelGesture, openAnnotationMenu],
  );

  // ---------------------------------------------------------------- pointer input (OSD canvas events)
  useEffect(() => {
    if (!viewer || !coords) return;
    const st = () => useStore.getState();
    const pos = (e: OsdEvent): Pt => ({ x: e.position.x, y: e.position.y });
    const isPrimary = (e: OsdEvent) => !(e.originalEvent instanceof MouseEvent) || e.originalEvent.button === 0;
    const hit = (p: Pt): Hit | null =>
      hitTest(coords, st().annotations.items, p, { selection: st().annotations.selection, hidden: useAnnUi.getState().hidden });
    const byId = (id: string) => st().annotations.items.find((a) => a.id === id);

    // while the slide is tipped in 3D (Adjust ▸ Perspective) pointer positions don't map onto the
    // tissue, so annotation input pauses: drags just pan
    const tiltedNow = () => isTilted(st().view);
    const onPress = (e: OsdEvent) => {
      if (!isPrimary(e) || tiltedNow()) return;
      const p = pos(e);
      const s = st();
      const tool = s.annotations.tool;
      const g = gesture.current;
      if (g?.mode === "poly" || g?.mode === "kbdraw") return; // points are added on click (or by key)
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
      if (!g || g.mode === "poly" || g.mode === "kbdraw") return;
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
      if (!g || g.mode === "poly" || g.mode === "kbdraw") return;
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
          if (big) {
            addAnnotation(a);
            endOneShot();
          }
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
      if (!e.quick || !isPrimary(e) || tiltedNow()) return;
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
      if (tiltedNow()) return;
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
    // the tool bar (or a key) picking a tool by hand ends menu one-shot mode
    const unsubTool = useStore.subscribe((now, before) => {
      if (now.annotations.tool !== before.annotations.tool && now.annotations.tool === "pan") oneShot.current = false;
    });

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
    // right-click: the annotation's menu, or (on the bare slide) the place / zoom menu (viewerMenu.ts)
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      // the Menu key can also send a contextmenu event after we've opened the menu from its keydown
      if (performance.now() - kbMenuAt.current < 1000) return;
      if (tiltedNow()) {
        st().setUi({
          menu: {
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: "Straighten (remove perspective tilt)", onSelect: () => st().setView({ tiltX: 0, tiltY: 0 }) },
              "sep",
              { label: "Zoom", submenu: zoomItems() },
            ],
          },
        });
        return;
      }
      openMenuAt(coords.eventToScreen(e), { x: e.clientX, y: e.clientY });
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("contextmenu", onContext);
    return () => {
      for (const [n, f] of handlers) v.removeHandler(n, f);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("contextmenu", onContext);
      unsubTool();
      viewer.canvas.style.cursor = "";
    };
  }, [viewer, coords, draw, newItem, finishPoly, cancelGesture, endOneShot, openMenuAt]);

  // ---------------------------------------------------------------- keys (capture: before lib/keys.ts)
  useEffect(() => {
    if (!viewer || !coords) return;
    const centre = (): Pt => ({ x: viewer.element.clientWidth / 2, y: viewer.element.clientHeight / 2 });
    /** a screen point in the viewer → client coordinates (kept inside the viewer) */
    const toClient = (p: Pt): Pt => {
      const r = viewer.element.getBoundingClientRect();
      return { x: r.left + Math.max(0, Math.min(r.width, p.x)), y: r.top + Math.max(0, Math.min(r.height, p.y)) };
    };
    /** ⇧F10 / Menu key: the selection's menu, else the slide menu at the cursor (the view centre) */
    const keyboardMenu = () => {
      const s = useStore.getState();
      const sel = s.annotations.selection;
      const a = sel.length ? s.annotations.items.find((x) => x.id === sel[sel.length - 1]) : undefined;
      if (a) return openAnnotationMenu(a, sel, toClient(coords.nmToScreen(anchorOf(a))));
      const c = centre();
      openMenuAt(c, toClient(c));
    };
    /** Space / ↵ with the keyboard cursor on: a click at the cursor. Returns true when it did something. */
    const cursorAction = (enter: boolean, shift: boolean): boolean => {
      const s = useStore.getState();
      const g = gesture.current;
      // a11y(audit): finish a pan that's still animating, so the point lands where the cursor will rest
      // (a quick ← then Space would otherwise set it short of the target, or say "pan first")
      const vp = viewer.viewport;
      vp.panTo(vp.getCenter(false), true);
      vp.zoomTo(vp.getZoom(false), undefined, true);
      const c = centre();
      const at = coords.screenToNm(c);
      if (g?.mode === "poly") {
        const first = coords.nmToScreen(g.pts[0]);
        if (g.pts.length >= 3 && ((enter && shift) || dist(c, first) <= 8)) {
          finishPoly();
          return true;
        }
        if (enter && shift) {
          announce("An outline needs at least 3 points.");
          return true;
        }
        if (dist(c, coords.nmToScreen(g.pts[g.pts.length - 1])) < DRAG_MIN) {
          announce("Pan to the next point first.");
          return true;
        }
        g.pts.push(at);
        announce(`Point ${g.pts.length} set.${g.pts.length >= 3 ? " Shift Enter closes the outline." : ""}`);
        draw();
        return true;
      }
      if (g?.mode === "kbdraw") {
        if (dist(coords.nmToScreen(g.start), c) < DRAG_MIN) {
          announce("Pan away from the first point, then set the second.");
          return true;
        }
        const a = { ...(g.a ?? newItem(g.tool, [g.start])), ...shapeFromPoints(g.tool, g.start, at) };
        gesture.current = null;
        addAnnotation(a);
        endOneShot();
        draw();
        rerender();
        return true;
      }
      if (g) return false; // a mouse gesture is under way
      const tool = s.annotations.tool;
      if (tool === "ruler" || tool === "circle" || tool === "rectangle") {
        gesture.current = { mode: "kbdraw", tool, start: at, a: null };
        announce(`${tool === "circle" ? "Centre" : "First point"} set. Pan with the arrow keys, then press Space for the ${tool === "circle" ? "edge" : "second point"}.`);
        draw();
        rerender();
        return true;
      }
      if (tool === "freehand") {
        gesture.current = { mode: "poly", pts: [at], hover: at, skipClick: false, kb: true };
        announce("Point 1 set. Pan and press Space for each point.");
        draw();
        rerender();
        return true;
      }
      if (tool === "pin") {
        placePinAt(at, "pin");
        return true;
      }
      // Pan tool: Space clicks (selects what's under the cursor), ↵ right-clicks (the menu)
      if (enter) {
        openMenuAt(c, toClient(c));
        return true;
      }
      const h = hitTest(coords, s.annotations.items, c, { selection: s.annotations.selection, hidden: useAnnUi.getState().hidden });
      if (h) {
        s.select(shift ? (s.annotations.selection.includes(h.id) ? s.annotations.selection.filter((x) => x !== h.id) : [...s.annotations.selection, h.id]) : [h.id]);
        const a = s.annotations.items.find((x) => x.id === h.id);
        if (a) announce(`Selected ${describeAnnotation(a, { calibrated: s.slide.info?.calibrated ?? true })}.`);
      } else if (s.annotations.selection.length) {
        s.select([]);
        announce("Nothing under the cursor. Selection cleared.");
      } else announce("Nothing under the cursor.");
      return true;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target) || useStore.getState().ui.menu) return;
      // a dialog owns the keyboard while it's open
      if (document.querySelector(".modal-backdrop")) return;
      if (characterKeyBlocked(e)) return; // a11y(audit): WCAG 2.1.4, Preferences ▸ Accessibility
      if (isTilted(useStore.getState().view)) return; // no annotation keys on a tipped slide
      const s = useStore.getState();
      const g = gesture.current;
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.metaKey || e.ctrlKey) {
        // undo / redo mid-gesture: drop the gesture first
        if (e.key.toLowerCase() === "z") cancelGesture();
        return;
      }
      const arrow = e.key === "ArrowLeft" ? [-1, 0] : e.key === "ArrowRight" ? [1, 0] : e.key === "ArrowUp" ? [0, -1] : e.key === "ArrowDown" ? [0, 1] : null;
      if (e.altKey) {
        // ⌥ arrows: move the selection in screen directions (so it follows the rotation), ⌥⇧ in bigger steps
        if (arrow && s.annotations.selection.length && !g) {
          consume();
          const step = e.shiftKey ? KB_NUDGE_BIG_PX : KB_NUDGE_PX;
          const c = centre();
          const n0 = coords.screenToNm(c);
          const n1 = coords.screenToNm({ x: c.x + arrow[0] * step, y: c.y + arrow[1] * step });
          nudgeSelection(Math.round(n1.x - n0.x), Math.round(n1.y - n0.y));
        }
        return;
      }
      if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
        consume();
        kbMenuAt.current = performance.now();
        keyboardMenu();
        return;
      }
      const kb = !!useAnnUi.getState().kbCursor;
      if (e.key === "Escape") {
        if (cancelGesture()) return consume();
        if (s.annotations.selection.length) {
          s.select([]);
          return consume();
        }
        if (oneShot.current && s.annotations.tool !== "pan") {
          endOneShot();
          return consume();
        }
        // last step: the keyboard cursor goes off (keys.ts first takes the tool back to Pan)
        if (kb && s.annotations.tool === "pan") {
          setKbCursor(false);
          return consume();
        }
        return;
      }
      if (e.key === "F2" && s.annotations.selection.length === 1) {
        consume();
        s.setAnnotations({ editingId: s.annotations.selection[0] });
        return;
      }
      if (kb && focusOnSlide(e.target)) {
        if ((e.key === "p" || e.key === "P") && !g) {
          consume();
          placePinAt(coords.screenToNm(centre()), e.shiftKey ? "flag" : "pin");
          return;
        }
        if ((e.key === " " || e.key === "Enter") && cursorAction(e.key === "Enter", e.shiftKey)) return consume();
      }
      // ↵ on the focused slide turns the keyboard cursor on (when ↵ has nothing else to do)
      if (!kb && e.key === "Enter" && e.target === viewer.canvas && !g && s.annotations.selection.length !== 1) {
        consume();
        setKbCursor(true);
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
          if (g.kb) announce(g.pts.length ? `Point removed. ${g.pts.length} left.` : "Outline cancelled.");
          draw();
          return;
        }
      }
      if ((e.key === "Delete" || e.key === "Backspace") && s.annotations.selection.length) {
        consume();
        deleteAnnotations(s.annotations.selection);
        return;
      }
      // a11y(semantics): Enter on a focused button / list row / tree item presses it rather than renaming the selection
      const onControl = !!(e.target as HTMLElement | null)?.closest?.('button, [role="button"], [role="treeitem"], [role="tab"]');
      if (e.key === "Enter" && s.annotations.selection.length === 1 && !onControl) {
        consume();
        s.setAnnotations({ editingId: s.annotations.selection[0] });
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [viewer, coords, cancelGesture, finishPoly, draw, endOneShot, newItem, openMenuAt, openAnnotationMenu, placePinAt]);

  // ---------------------------------------------------------------- the keyboard cursor on / off
  useEffect(
    () =>
      useAnnUi.subscribe((now, before) => {
        if (!!now.kbCursor === !!before.kbCursor) return;
        const g = gesture.current;
        if (!now.kbCursor && (g?.mode === "kbdraw" || (g?.mode === "poly" && g.kb))) cancelGesture();
        announce(
          now.kbCursor
            ? "Keyboard cursor on, at the centre of the view. Arrow keys pan the slide under it, Space clicks, Enter opens the menu, P places a pin, Escape turns it off."
            : "Keyboard cursor off.",
        );
        draw();
      }),
    [cancelGesture, draw],
  );

  // ---------------------------------------------------------------- the slide as a focusable region
  useEffect(() => {
    if (!viewer) return;
    const cv = viewer.canvas as HTMLElement;
    // OSD puts its canvas in the tab order; make sure, and name it (unless the viewer already did)
    if (cv.tabIndex < 0 || !cv.hasAttribute("tabindex")) cv.tabIndex = 0;
    const added: string[] = [];
    const attr = (k: string, v: string) => {
      if (cv.hasAttribute(k)) return;
      cv.setAttribute(k, v);
      added.push(k);
    };
    attr("role", "application");
    attr("aria-roledescription", "slide viewer");
    attr("aria-label", "Slide. X: keyboard cursor. N: next annotation. Shift F10: menu. Tab leaves the slide.");
    let keyboardInput = false;
    const onAnyKey = () => (keyboardInput = true);
    const onAnyPointer = () => (keyboardInput = false);
    const show = (on: boolean) => {
      if (ring.current === on) return;
      ring.current = on;
      draw();
    };
    const onFocus = () => show(keyboardInput);
    const onBlur = () => show(false);
    const onCanvasKey = (e: KeyboardEvent) => {
      if (e.key !== "Shift" && e.key !== "Meta" && e.key !== "Control" && e.key !== "Alt") show(true);
    };
    const onCanvasPointer = () => show(false);
    window.addEventListener("keydown", onAnyKey, true);
    window.addEventListener("pointerdown", onAnyPointer, true);
    cv.addEventListener("focus", onFocus);
    cv.addEventListener("blur", onBlur);
    cv.addEventListener("keydown", onCanvasKey);
    cv.addEventListener("pointerdown", onCanvasPointer);
    if (document.activeElement === cv) show(true);
    return () => {
      window.removeEventListener("keydown", onAnyKey, true);
      window.removeEventListener("pointerdown", onAnyPointer, true);
      cv.removeEventListener("focus", onFocus);
      cv.removeEventListener("blur", onBlur);
      cv.removeEventListener("keydown", onCanvasKey);
      cv.removeEventListener("pointerdown", onCanvasPointer);
      for (const k of added) cv.removeAttribute(k);
      ring.current = false;
    };
  }, [viewer, draw]);

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
            // ↵ / Esc in the editor: the focus goes back to the slide rather than being lost
            setTimeout(() => {
              const at = document.activeElement;
              if ((!at || at === document.body) && viewer) viewer.canvas.focus({ preventScroll: true });
            }, 0);
          }}
          onMount={draw}
        />
      )}
    </>
  );
}

const roundPt = (p: PtNm): PtNm => ({ x: Math.round(p.x), y: Math.round(p.y) });

// ---------------------------------------------------------------- keyboard cursor and focus ring (screen px)

/** the keyboard cursor: a cross-hair with a dark halo, so it shows on any stain (≥ 3:1, WCAG 1.4.11) */
function drawReticle(ctx: CanvasRenderingContext2D, c: Pt) {
  const arms: [number, number, number, number][] = [
    [c.x - 16, c.y, c.x - 5, c.y],
    [c.x + 5, c.y, c.x + 16, c.y],
    [c.x, c.y - 16, c.x, c.y - 5],
    [c.x, c.y + 5, c.x, c.y + 16],
  ];
  ctx.lineCap = "round";
  for (const [w, color] of [
    [5, "rgba(0,0,0,0.85)"],
    [2, "#ffffff"],
  ] as const) {
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of arms) {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.lineWidth = w;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  drawDot(ctx, c, 1.8);
}

function drawDot(ctx: CanvasRenderingContext2D, p: Pt, r = 3.5) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.85)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
}

/** the slide's focus ring: the app's accent inside a dark edge (visible on light and dark slides) */
function drawFocusRing(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#5ab0ff";
  ctx.lineWidth = 3;
  ctx.strokeStyle = accent;
  ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0,0,0,0.8)";
  ctx.strokeRect(3.5, 3.5, w - 7, h - 7);
}

/** what Space / ↵ will do next, shown beside the cursor */
function cursorHint(tool: string, g: Gesture | null): string {
  if (g?.mode === "kbdraw") return `Space: set the ${g.tool === "circle" ? "edge" : "second point"} · Esc: cancel`;
  if (g?.mode === "poly") return g.pts.length >= 3 ? "Space: add a point · ⇧↵: close · ⌫: undo point" : "Space: add a point · ⌫: undo point";
  if (tool === "ruler" || tool === "rectangle") return `Space: set the first point (${KIND_LABEL[tool === "ruler" ? "ruler" : "rectangle"].toLowerCase()})`;
  if (tool === "circle") return "Space: set the centre (circle)";
  if (tool === "freehand") return "Space: first point (outline)";
  if (tool === "pin") return "Space: place a pin";
  return "Space: select · ↵: menu · P: pin · Esc: cursor off";
}

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
