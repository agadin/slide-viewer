// Formats backend contract, seen from the frontend (owner: formats builder).
// The Rust side is tested in src-tauri/src/source/** (`cargo test`); this checks what the
// frontend relies on: the SlideInfo JSON shape, the z-plane convention and the tile URLs.
import { eq, ok, test } from "./harness";
import { tileUrl } from "../src/lib/backend";
import type { SlideInfo } from "../src/lib/types";

/** Exactly what `source::tests::slide_info_json_shape` asserts the backend sends. */
const fixture: SlideInfo = {
  id: 1,
  path: "/a/b.png",
  tileSize: 256,
  maxLevel: 10,
  format: "plain",
  vendor: null,
  width: 1000,
  height: 600,
  mppX: 1.0,
  mppY: 1.0,
  calibrated: false,
  xOffsetNm: 0,
  yOffsetNm: 0,
  levels: [{ width: 1000, height: 600, downsample: 1 }],
  zPlanes: [
    { index: 1, offsetNm: -500, label: "−0.5 µm" },
    { index: 0, offsetNm: 0, label: "0 µm" },
  ],
  associated: ["thumbnail"],
};

/** Deep-Zoom geometry as source/mod.rs computes it (dz_max_level / dz_level_size). */
const dzMaxLevel = (w: number, h: number) => Math.ceil(Math.log2(Math.max(w, h, 1)));
const dzLevelSize = (w: number, h: number, level: number) => {
  const ds = 2 ** (dzMaxLevel(w, h) - level);
  return [Math.ceil(w / ds), Math.ceil(h / ds)];
};

test("formats: SlideInfo shape and Deep-Zoom levels", () => {
  eq(fixture.maxLevel, dzMaxLevel(fixture.width, fixture.height), "maxLevel = ceil(log2(max(w, h)))");
  eq(dzLevelSize(1000, 600, 9), [500, 300], "each level halves (ceil)");
  eq(dzLevelSize(1025, 1, 11), [1025, 1], "full resolution at maxLevel");
  eq(dzMaxLevel(43648, 22016), 16, "VMS104-sized slide");
  ok(!fixture.calibrated && fixture.mppX === 1, "uncalibrated = mpp 1 + calibrated false");
});

test("formats: z planes are in slider order, index 0 is the in-focus plane", () => {
  const planes = fixture.zPlanes;
  ok(planes.length >= 1, "always at least one plane");
  ok(planes.some((p) => p.index === 0), "a plane with index 0 exists (the default view)");
  const offs = planes.map((p) => p.offsetNm ?? 0);
  eq(offs, [...offs].sort((a, b) => a - b), "array order = focus order");
  eq(new Set(planes.map((p) => p.index)).size, planes.length, "indices are unique");
});

test("formats: tile URLs (z 0 drops the z segment)", () => {
  ok(tileUrl(3, 12, 4, 5).endsWith("/3/12/4_5.jpg"), tileUrl(3, 12, 4, 5));
  ok(tileUrl(3, 12, 4, 5, 0).endsWith("/3/12/4_5.jpg"), "explicit z 0");
  ok(tileUrl(3, 12, 4, 5, 2).endsWith("/3/2/12/4_5.jpg"), tileUrl(3, 12, 4, 5, 2));
});
