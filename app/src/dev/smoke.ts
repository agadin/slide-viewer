/**
 * Dev-only end-to-end smoke run inside the real app (Tauri + Rust backend). Loaded by main.tsx only when
 * `import.meta.env.DEV` and the window URL has `?smoke=<folder>`; never part of a production build.
 *
 * Start it with tools/smoke.sh, which makes a scratch folder holding a symlinked slide and a copy of its
 * .ndpa, then runs `tauri dev` with that URL. Steps: scan the folder, open the first slide, check the
 * existing annotations loaded, place a pin with the real pin tool (synthetic pointer events on the
 * OpenSeadragon canvas and a typed title), wait for autosave, and read the .ndpa back from disk. The
 * result goes to <folder>/smoke-report.json; `stage` lines let the script take screenshots.
 */
import { useStore } from "../lib/store";
import { useSettings } from "../lib/settings";
import { openEntry, openFolder } from "../lib/browser";
import { readText, writeText } from "../lib/backend";

const dir = new URLSearchParams(location.search).get("smoke")!;
const report: Record<string, unknown> = { started: new Date().toISOString(), stages: [] as string[] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const st = () => useStore.getState();

async function waitFor<T>(what: string, f: () => T | null | undefined | false, ms = 30000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const save = () => writeText(`${dir}/smoke-report.json`, JSON.stringify(report, null, 2));
async function stage(name: string, hold = 2500) {
  (report.stages as string[]).push(name);
  report.stage = name;
  await save();
  await sleep(hold); // the shell script screenshots the window while we hold
}

function pointer(el: Element, type: string, x: number, y: number) {
  el.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, pointerType: "mouse", isPrimary: true }),
  );
}

async function run() {
  await sleep(1500);
  await openFolder(dir);
  const scan = await waitFor("scan", () => !st().browser.scanning && st().browser.scan);
  report.scanned = scan.entries.map((e) => ({ name: e.name, annotationCount: e.annotationCount ?? null }));
  const entry = scan.entries[0];
  if (!entry) throw new Error("no slide found in the smoke folder");
  openEntry(entry);
  const info = await waitFor("slide info", () => st().slide.info, 60000);
  report.slide = { width: info.width, height: info.height, mppX: info.mppX, calibrated: info.calibrated, zPlanes: info.zPlanes?.length };
  await waitFor("annotations file", () => st().annotations.filePath);
  await sleep(800);
  const before = st().annotations.items.map((a) => ({ kind: a.kind, title: a.title }));
  report.loadedAnnotations = before;
  await stage("slide-open", 4000);

  // place a pin with the pin tool at the centre of the slide
  st().setTool("pin");
  const canvas = await waitFor("viewer canvas", () => document.querySelector(".openseadragon-canvas"));
  const r = canvas.getBoundingClientRect();
  const x = r.left + r.width * 0.55, y = r.top + r.height * 0.45;
  pointer(canvas, "pointerover", x, y);
  pointer(canvas, "pointerenter", x, y);
  pointer(canvas, "pointermove", x, y);
  pointer(canvas, "pointerdown", x, y);
  await sleep(40);
  pointer(canvas, "pointerup", x, y);
  let via = "pin tool click";
  const editor = await waitFor("title editor", () => document.querySelector<HTMLInputElement>(".ann-title-editor"), 3000).catch(() => null);
  const title = "Q2";
  if (editor) {
    editor.value = title;
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  } else {
    via = "store fallback (synthetic click did not reach the layer)";
    const { addAnnotation, makeAnnotation } = await import("../lib/annotations");
    const v = st().view;
    addAnnotation(makeAnnotation("pin", [{ x: 0, y: 0 }], { color: "#00ff00", items: st().annotations.items, title, lens: v.magnification, z: v.z }));
  }
  report.pinVia = via;
  await waitFor("pin added", () => st().annotations.items.some((a) => a.title === title), 5000);
  st().setTool("pan");
  await waitFor("autosave", () => st().annotations.save === "saved", 15000);
  const path = st().annotations.filePath!;
  const xml = await readText(path);
  report.savedFile = path;
  report.savedHasPin = xml.includes(`<title>${title}</title>`);
  report.savedCount = (xml.match(/<ndpviewstate\b/g) ?? []).length;
  report.afterAnnotations = st().annotations.items.length;
  await stage("pin-saved", 4000);

  // adjustments on, then a screenshot with the Adjust tab
  st().setUi({ panelTab: "adjust" });
  st().setFilterParams({ gamma: 1.4, contrast: 0.15 });
  st().setFilters({ enabled: true });
  await stage("adjust", 3500);
  st().setFilterParams({ gamma: 1, contrast: 0 });
  st().setUi({ panelTab: "annotations" });

  // don't reopen the scratch folder next time the app starts
  useSettings.getState().setSection("browser", { lastFolder: null, lastSlide: null });
  report.ok = report.savedHasPin === true && before.length > 0;
}

run()
  .catch((e) => {
    report.ok = false;
    report.error = String(e);
  })
  .finally(async () => {
    report.finished = new Date().toISOString();
    await save();
    await stage("done", 500);
  });
