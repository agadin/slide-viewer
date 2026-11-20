// Foundation smoke tests: coordinates, store, settings, MSG's NDPA reader on the real NDP.view2 files.
import fs from "node:fs";
import path from "node:path";
import { dataDir, eq, near, ok, test } from "./harness";
import { imageToNm, magFromUmPerPx, nmToImage, umPerPxFromMag } from "../src/lib/coords";
import { useStore } from "../src/lib/store";
import { defaultSettings, mergeSettings } from "../src/lib/settings";
import { parseNdpa } from "../src/lib/ndpa";
import { DEFAULT_FILTERS, type Annotation } from "../src/lib/types";

const info = { width: 100000, height: 50000, mppX: 0.25, mppY: 0.25, xOffsetNm: 1200000, yOffsetNm: -340000 };

test("coords: image <-> nm", () => {
  const c = imageToNm(info, { x: 50000, y: 25000 });
  eq(c, { x: 1200000, y: -340000 }, "image centre is the Hamamatsu offset");
  const p = imageToNm(info, { x: 50004, y: 25000 });
  near(p.x - c.x, 1000, 1e-9, "4 px at 0.25 µm/px = 1000 nm");
  const back = nmToImage(info, imageToNm(info, { x: 1234.5, y: 678.25 }));
  near(back.x, 1234.5, 1e-6, "round trip x");
  near(back.y, 678.25, 1e-6, "round trip y");
  near(magFromUmPerPx(0.25), 40, 1e-9, "0.25 µm/px is 40×");
  near(umPerPxFromMag(10), 1, 1e-9, "10× is 1 µm/px");
});

test("store: commit / undo / redo", () => {
  const s = useStore.getState();
  const a = (id: string): Annotation => ({ id, ndpaId: null, kind: "pin", title: id, details: "", color: "#00ff00", points: [{ x: 0, y: 0 }] });
  s.commit([a("1")]);
  useStore.getState().select(["1"]);
  useStore.getState().commit([a("1"), a("2")]);
  eq(useStore.getState().annotations.items.map((x) => x.id), ["1", "2"], "two items");
  useStore.getState().undo();
  eq(useStore.getState().annotations.items.map((x) => x.id), ["1"], "undo");
  useStore.getState().redo();
  eq(useStore.getState().annotations.items.map((x) => x.id), ["1", "2"], "redo");
  useStore.getState().commit([a("2")]);
  eq(useStore.getState().annotations.selection, [], "selection drops removed ids");
  ok(useStore.getState().annotations.save === "dirty", "commit marks dirty");
  useStore.getState().setFilterParams({ gamma: 1.5 });
  ok(useStore.getState().filters.params.gamma === 1.5 && useStore.getState().filters.params.contrast === DEFAULT_FILTERS.contrast, "filter params merge");
});

test("settings: merge over defaults", () => {
  const m = mergeSettings({ viewer: { animate: false }, junk: 1 });
  ok(m.viewer.animate === false && m.viewer.zoomPerScroll === defaultSettings.viewer.zoomPerScroll, "partial block keeps defaults");
  eq(mergeSettings(null), defaultSettings, "nothing saved = defaults");
});

test("ndpa: MSG reader reads the NDP.view2 test files", () => {
  if (!fs.existsSync(dataDir)) return ok(true, `no ${dataDir} (skipped)`);
  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".ndpa"));
  let n = 0;
  for (const f of files) n += parseNdpa(fs.readFileSync(path.join(dataDir, f), "utf8")).length;
  ok(files.length > 0 && n >= files.length, `${files.length} files, ${n} annotations`);
});
