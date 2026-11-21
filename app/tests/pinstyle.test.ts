// Pin styles: NDP.view "pin" vs "flag" icons (real files: pingreen, flagred) survive read → edit → write.
import fs from "node:fs";
import path from "node:path";
import { dataDir, eq, ok, test } from "./harness";
import { loadNdpa, parseNdpa, serializeNdpa } from "../src/lib/ndpa";
import { makeAnnotation } from "../src/lib/annotations";

const shapes = path.join(dataDir, "VMS105-shapes.ndpi.ndpa");

test("pin style: flag pins in a real NDP.view2 file are read as flags", () => {
  if (!fs.existsSync(shapes)) return;
  const { items } = loadNdpa(fs.readFileSync(shapes, "utf8"));
  const pins = items.filter((a) => a.kind === "pin");
  ok(pins.length > 0, "has pins");
  ok(pins.every((a) => a.pinStyle === "flag"), "every flagred pin is a flag");
});

test("pin style: a new flag writes flag icons; a new pin writes pin icons", () => {
  const flag = makeAnnotation("pin", [{ x: 1000, y: -2000 }], { color: "#0000ff", items: [], pinStyle: "flag" });
  const pin = makeAnnotation("pin", [{ x: 3000, y: 4000 }], { color: "#00ff00", items: [flag] });
  const xml = serializeNdpa(null, [flag, pin]);
  ok(xml.includes("<icon>flagblue</icon>") && xml.includes("<stricon>iconflagblue</stricon>"), "flag icon names");
  ok(xml.includes("<icon>pingreen</icon>") && xml.includes("<stricon>iconpingreen</stricon>"), "pin icon names");
  eq(parseNdpa(xml).length, 2, "MSG's parser reads both");
  const back = loadNdpa(xml).items;
  eq(back.map((a) => a.pinStyle ?? "pin"), ["flag", "pin"], "styles round-trip");
});

test("pin style: switching an existing pin to a flag (and recolouring) rewrites both icon names only", () => {
  const src = serializeNdpa(null, [makeAnnotation("pin", [{ x: 5, y: 6 }], { color: "#00ff00", items: [] })]);
  const { doc, items } = loadNdpa(src);
  const out = serializeNdpa(doc, [{ ...items[0], pinStyle: "flag", color: "#ff0000" }]);
  ok(out.includes("<icon>flagred</icon>") && out.includes("<stricon>iconflagred</stricon>"), "icons rewritten");
  ok(out.includes('color="#ff0000"'), "colour attribute");
  const again = loadNdpa(out).items[0];
  eq([again.pinStyle, again.points[0].x, again.points[0].y], ["flag", 5, 6], "geometry untouched");
});
