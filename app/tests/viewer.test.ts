// Tests for the viewer feature. Owner: viewer builder (CONTRACTS.md).
import { test, ok, eq, near } from "./harness";
import {
  fmtMag,
  fmtPercent,
  fmtUm,
  imageFromNav,
  imageZoomForMag,
  magForImageZoom,
  navFromImage,
  navLayout,
  nativeMag,
  normDeg,
  presetState,
  scaleBar,
  signedDeg,
  snapRotate,
  snapshotName,
  snapshotRegion,
} from "../src/components/viewer/viewMath";
import { makeCoords, type CoordsViewport } from "../src/components/viewer/makeCoords";
import { keyAction, deleteSelection, stepPlane, rotateStep, rotateBy } from "../src/lib/keys";
import { useStore } from "../src/lib/store";
import { imageToNm } from "../src/lib/coords";
import type { Annotation, SlideInfo } from "../src/lib/types";
import type OpenSeadragon from "openseadragon";

const slide = (p: Partial<SlideInfo> = {}): SlideInfo => ({
  id: 1,
  path: "/x/VMS104.ndpi",
  tileSize: 256,
  maxLevel: 17,
  format: "openslide",
  vendor: "hamamatsu",
  width: 100000,
  height: 60000,
  mppX: 0.4416,
  mppY: 0.4416,
  calibrated: true,
  xOffsetNm: 1200000,
  yOffsetNm: -300000,
  levels: [],
  zPlanes: [{ index: 0, offsetNm: 0, label: "0 µm" }],
  associated: [],
  ...p,
});

test("viewer: angles", () => {
  eq(normDeg(-90), 270, "normDeg(-90)");
  eq(normDeg(720), 0, "normDeg(720)");
  eq(signedDeg(270), -90, "signedDeg(270)");
  eq(signedDeg(180), 180, "signedDeg(180)");
  eq(snapRotate(0, 90, 1), 90, "0 → 90");
  eq(snapRotate(37, 90, 1), 90, "37 → 90");
  eq(snapRotate(37, 90, -1), 0, "37 ← 0");
  eq(snapRotate(0, 90, -1), 270, "0 ← 270");
  eq(snapRotate(270, 90, 1), 0, "270 → 0");
  eq(snapRotate(90, 90, -1), 0, "90 ← 0");
});

test("viewer: magnification and presets", () => {
  near(nativeMag(0.25), 40, 1e-9, "0.25 µm/px is 40×");
  near(imageZoomForMag(20, 0.5), 1, 1e-9, "20× on 0.5 µm/px is 1:1");
  near(magForImageZoom(imageZoomForMag(13.7, 0.4416), 0.4416), 13.7, 1e-9, "mag ↔ image zoom round trip");
  eq(presetState(40, 0.25), "optical", "40× on a 40× scan is optical");
  eq(presetState(40, 0.5), "digital", "40× on a 20× scan is digital");
  eq(presetState(40, 1.5), "off", "40× on a 6.7× scan is past the zoom limit");
  eq(fmtMag(1.25), "1.25×", "fmtMag 1.25");
  eq(fmtMag(2.5), "2.5×", "fmtMag 2.5");
  eq(fmtMag(10), "10×", "fmtMag 10");
  eq(fmtMag(12.345), "12.3×", "fmtMag 12.3");
  eq(fmtMag(null), "–", "fmtMag null");
  eq(fmtPercent(1), "100%", "fmtPercent 1");
  eq(fmtPercent(0.031), "3.1%", "fmtPercent small");
});

test("viewer: scale bar", () => {
  const a = scaleBar(1, 140)!;
  eq([a.value, Math.round(a.px), a.label], [100, 100, "100 µm"], "1 µm/px → 100 µm over 100 px");
  const b = scaleBar(0.25, 140)!;
  eq([b.value, Math.round(b.px), b.label], [20, 80, "20 µm"], "0.25 µm/px → 20 µm");
  const c = scaleBar(10, 140)!;
  eq([c.value, c.label], [1000, "1 mm"], "10 µm/px → 1 mm");
  const d = scaleBar(3, 140, false)!;
  eq(d.label, "200 px", "uncalibrated shows px");
  ok(scaleBar(0, 140) === null && scaleBar(NaN) === null, "no bar for a bad scale");
  for (const u of [0.01, 0.37, 2.2, 55, 900]) {
    const s = scaleBar(u, 140)!;
    ok(s.px <= 140 + 1e-6 && s.px > 140 / 5 - 1e-6, `bar for ${u} µm/px fits (${s.px.toFixed(1)} px)`);
  }
  eq(fmtUm(0.5), "500 nm", "fmtUm sub-µm");
  eq(fmtUm(5000), "5 mm", "fmtUm mm");
});

test("viewer: navigator mapping", () => {
  for (const rot of [0, 90, 180, 270, 37]) {
    const L = navLayout(100000, 60000, rot, 200, 170);
    ok(L.width <= 200 && L.height <= 170, `layout fits at ${rot}° (${L.width}×${L.height})`);
    for (const p of [
      { x: 0, y: 0 },
      { x: 100000, y: 60000 },
      { x: 12345, y: 54321 },
    ]) {
      const n = navFromImage(L, p);
      const back = imageFromNav(L, n);
      near(back.x, p.x, 1e-6, `nav round trip x at ${rot}°`);
      near(back.y, p.y, 1e-6, `nav round trip y at ${rot}°`);
      ok(n.x >= -1 && n.x <= L.width + 1 && n.y >= -1 && n.y <= L.height + 1, `corner inside the map at ${rot}°`);
    }
  }
  const L0 = navLayout(100000, 60000, 0, 200);
  const L90 = navLayout(100000, 60000, 90, 200);
  eq([L90.width, L90.height], [L0.height, L0.width], "90° swaps the map's sides");
  // clockwise: the slide's top-left corner goes to the top-right at 90°
  const tl = navFromImage(L90, { x: 0, y: 0 });
  ok(tl.x > L90.width - 2 && tl.y < 2, "90° is clockwise (top-left → top-right)");
});

test("viewer: snapshot region", () => {
  const r = snapshotRegion(
    [
      { x: 100, y: 200 },
      { x: 1100, y: 200 },
      { x: 1100, y: 800 },
      { x: 100, y: 800 },
    ],
    0.5,
    2,
  );
  eq([r.x, r.y, r.width, r.height, r.outWidth, r.outHeight], [100, 200, 1000, 600, 1000, 600], "region and output size");
  const big = snapshotRegion(
    [
      { x: 0, y: 0 },
      { x: 100000, y: 0 },
      { x: 100000, y: 100000 },
    ],
    1,
    4,
    8192,
  );
  ok(big.outWidth <= 8192 && big.outHeight <= 8192, "output is capped");
  eq(snapshotName("/a/b/VMS104.ndpi"), "VMS104 view.png", "snapshot file name");
  eq(snapshotName("C:\\s\\x.svs"), "x view.png", "snapshot file name (Windows path)");
});

/** a fake OSD viewport: zoom z screen px per viewport unit, rotation about the view centre (OSD semantics) */
function fakeViewport(info: SlideInfo, z: number, rot: number, centre: { x: number; y: number }, size = { x: 1000, y: 700 }): CoordsViewport {
  const rad = (rot * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const Pt = (x: number, y: number) => ({ x, y }) as unknown as OpenSeadragon.Point;
  const bw = size.x / z;
  const bounds = { x: centre.x - bw / 2, y: centre.y - size.y / z / 2, width: bw, height: size.y / z };
  void info;
  return {
    pixelFromPoint: (p: { x: number; y: number }) => {
      const dx = p.x - centre.x, dy = p.y - centre.y;
      const rx = centre.x + dx * cos - dy * sin, ry = centre.y + dx * sin + dy * cos;
      return Pt((rx - bounds.x) * z, (ry - bounds.y) * z);
    },
    pointFromPixel: (px: { x: number; y: number }) => {
      const vx = px.x / z + bounds.x, vy = px.y / z + bounds.y;
      const dx = vx - centre.x, dy = vy - centre.y;
      return Pt(centre.x + dx * cos + dy * sin, centre.y - dx * sin + dy * cos);
    },
    getBoundsNoRotate: () => bounds as unknown as OpenSeadragon.Rect,
    getContainerSize: () => Pt(size.x, size.y),
  } as unknown as CoordsViewport;
}
const P = (x: number, y: number) => ({ x, y }) as unknown as OpenSeadragon.Point;

test("viewer: coordinate helpers", () => {
  const info = slide();
  const host = { getBoundingClientRect: () => ({ left: 50, top: 30, width: 1000, height: 700 }) as DOMRect };
  for (const rot of [0, 90, 33]) {
    // 2000 screen px across the slide's width → 0.02 screen px per image px
    const c = makeCoords({ viewport: fakeViewport(info, 2000, rot, { x: 0.5, y: 0.3 }) }, info, host, P);
    const p = { x: 31234, y: 17890 };
    const s = c.imageToScreen(p);
    const back = c.screenToImage(s);
    near(back.x, p.x, 1e-6, `screen round trip x at ${rot}°`);
    near(back.y, p.y, 1e-6, `screen round trip y at ${rot}°`);
    const nm = c.screenToNm(s);
    const want = imageToNm(info, p);
    near(nm.x, want.x, 1e-3, `screenToNm x at ${rot}°`);
    near(nm.y, want.y, 1e-3, `screenToNm y at ${rot}°`);
    near(c.screenPxPerNm(), 0.02 / (info.mppX * 1000), 1e-15, `screen px per nm at ${rot}°`);
    near(c.umPerScreenPx(), info.mppX / 0.02, 1e-9, `µm per screen px at ${rot}°`);
    // the slide centre (image 50000, 30000) is at the view centre
    const mid = c.imageToScreen({ x: 50000, y: 30000 });
    near(mid.x, 500, 1e-6, `centre x at ${rot}°`);
    near(mid.y, 350, 1e-6, `centre y at ${rot}°`);
  }
  const c90 = makeCoords({ viewport: fakeViewport(info, 2000, 90, { x: 0.5, y: 0.3 }) }, info, host, P);
  const right = c90.imageToScreen({ x: 60000, y: 30000 });
  ok(Math.abs(right.x - 500) < 1e-6 && right.y > 350, "90° rotation is clockwise on screen (right of centre → below)");
  const ev = c90.eventToScreen({ clientX: 150, clientY: 130 });
  eq(ev, { x: 100, y: 100 }, "eventToScreen subtracts the host's offset");
});

test("viewer: key mapping", () => {
  eq(keyAction({ key: "z", metaKey: true }), { kind: "undo" }, "⌘Z undo");
  eq(keyAction({ key: "Z", metaKey: true, shiftKey: true }), { kind: "redo" }, "⌘⇧Z redo");
  eq(keyAction({ key: "y", ctrlKey: true }), { kind: "redo" }, "Ctrl+Y redo");
  eq(keyAction({ key: "p" }), { kind: "tool", tool: "pin" }, "P pin");
  eq(keyAction({ key: "B" }), { kind: "tool", tool: "rectangle" }, "B rectangle (caps)");
  eq(keyAction({ key: "v" }), { kind: "tool", tool: "pan" }, "V pan");
  eq(keyAction({ key: "Delete" }), { kind: "delete" }, "Delete");
  eq(keyAction({ key: "Backspace" }), { kind: "delete" }, "Backspace");
  eq(keyAction({ key: "[" }), { kind: "slide", dir: -1 }, "[ previous slide");
  eq(keyAction({ key: "ArrowRight" }), { kind: "slide", dir: 1 }, "→ next slide");
  eq(keyAction({ key: "0" }), { kind: "fit" }, "0 fit");
  eq(keyAction({ key: "=" }), { kind: "zoom", factor: 2 }, "= zoom in");
  eq(keyAction({ key: "+", shiftKey: true }), { kind: "zoom", factor: 2 }, "+ zoom in");
  eq(keyAction({ key: "-" }), { kind: "zoom", factor: 0.5 }, "- zoom out");
  eq(keyAction({ key: "." }), { kind: "rotate90", dir: 1 }, ". rotate right");
  eq(keyAction({ key: "<", code: "Comma", shiftKey: true }), { kind: "rotateFree", dir: -1 }, "⇧, free rotate left");
  eq(keyAction({ key: "ArrowUp", shiftKey: true }), { kind: "pan", fx: 0, fy: -0.25 }, "⇧↑ pans");
  eq(keyAction({ key: "PageUp" }), { kind: "plane", dir: 1 }, "PageUp plane");
  eq(keyAction({ key: "S", shiftKey: true }), { kind: "snapshot" }, "⇧S snapshot");
  eq(keyAction({ key: "p", metaKey: true }), null, "⌘P is not a tool");
  eq(keyAction({ key: "p", altKey: true }), null, "⌥P is not a tool");
  eq(keyAction({ key: "q" }), null, "unbound key");
});

test("viewer: store actions (delete, planes, rotation)", () => {
  const st = useStore.getState();
  const mk = (id: string): Annotation => ({ id, ndpaId: null, kind: "pin", title: id, details: "", color: "#00ff00", points: [{ x: 0, y: 0 }] });
  st.setAnnotations({ items: [mk("a"), mk("b"), mk("c")], selection: [], undo: [], redo: [] });
  ok(!deleteSelection(), "nothing selected → nothing deleted");
  st.select(["a", "c"]);
  ok(deleteSelection(), "deletes the selection");
  let a = useStore.getState().annotations;
  eq(a.items.map((x) => x.id), ["b"], "only b is left");
  eq(a.undo.length, 1, "one undo step");
  eq(a.selection, [], "selection cleared");
  useStore.getState().undo();
  a = useStore.getState().annotations;
  eq(a.items.map((x) => x.id), ["a", "b", "c"], "undo brings them back");

  st.setSlide({
    info: slide({
      zPlanes: [
        { index: 0, offsetNm: -1000, label: "-1 µm" },
        { index: 1, offsetNm: 0, label: "0 µm" },
        { index: 2, offsetNm: 1000, label: "+1 µm" },
      ],
    }),
  });
  st.setView({ z: 0, rotation: 0 });
  stepPlane(1);
  stepPlane(1);
  stepPlane(1);
  eq(useStore.getState().view.z, 2, "stepPlane stops at the last plane");
  stepPlane(-1);
  eq(useStore.getState().view.z, 1, "stepPlane down");

  rotateStep(90, 1);
  eq(useStore.getState().view.rotation, 90, "rotate right 90");
  rotateBy(-15);
  eq(useStore.getState().view.rotation, 75, "free rotate 15° left");
  rotateStep(90, -1);
  eq(useStore.getState().view.rotation, 0, "snap left to 0");
  rotateStep(90, -1);
  eq(useStore.getState().view.rotation, 270, "wraps to 270");
  st.setSlide({ info: null });
  st.setView({ z: 0, rotation: 0 });
  st.setAnnotations({ items: [], selection: [], undo: [], redo: [] });
});
