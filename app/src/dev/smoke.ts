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
import { getActiveViewer } from "../components/viewer/viewerHandle";

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

/** what OpenSeadragon has drawn: a black viewport in a screenshot is told apart from a hidden window here */
function viewerState() {
  const v = getActiveViewer()?.viewer as unknown as {
    world: { getItemCount(): number; getItemAt(i: number): { getFullyLoaded?: () => boolean } };
    viewport: { getZoom(c: boolean): number };
    container: HTMLElement;
  } | null;
  const item = v && v.world.getItemCount() ? v.world.getItemAt(0) : null;
  return {
    items: v?.world.getItemCount() ?? 0,
    fullyLoaded: item?.getFullyLoaded?.() ?? null,
    zoom: v?.viewport.getZoom(true) ?? null,
    container: v ? [v.container.clientWidth, v.container.clientHeight] : null,
    magnification: st().view.magnification,
    visibility: document.visibilityState,
    focused: document.hasFocus(),
  };
}

/**
 * How the slide really looks on screen after a layout change: the drawn image's on-screen width/height
 * ratio (OSD's own placement × any CSS stretch of the canvas bitmap) divided by the slide's true ratio.
 * 1.000 = undistorted.
 */
function aspectProbe() {
  const v = getActiveViewer()?.viewer as unknown as {
    world: { getItemAt(i: number): { getBounds(c: boolean): unknown } };
    viewport: { viewportToViewerElementRectangle(r: unknown): { width: number; height: number }; getContainerSize(): { x: number; y: number } };
    container: HTMLElement;
  } | null;
  const info = st().slide.info;
  if (!v || !info) return null;
  const host = v.container;
  const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".viewer-wrap canvas")]
    .filter((c) => getComputedStyle(c).display !== "none" && !c.closest(".sv-nav"))
    .map((c) => {
      const r = c.getBoundingClientRect();
      return { cls: c.className || "osd", bitmap: [c.width, c.height], shown: [Math.round(r.width), Math.round(r.height)], stretch: +((c.width / r.width) / (c.height / r.height)).toFixed(3) };
    });
  const osd = canvases.find((c) => c.cls === "osd" || c.cls === "") ?? canvases[0];
  const rect = v.viewport.viewportToViewerElementRectangle(v.world.getItemAt(0).getBounds(true));
  const placed = rect.width / rect.height / (info.width / info.height);
  // a canvas bitmap wider than it's shown squeezes the picture horizontally by that factor
  const cssStretch = osd ? 1 / osd.stretch : 1;
  return {
    container: [host.clientWidth, host.clientHeight],
    osdContainerSize: [Math.round(v.viewport.getContainerSize().x), Math.round(v.viewport.getContainerSize().y)],
    canvases,
    placedAspect: +placed.toFixed(3),
    displayedAspect: +(placed * cssStretch).toFixed(3),
  };
}
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

async function panelProbe() {
  const out: unknown[] = [];
  report.panelProbe = out;
  const steps: [string, () => void][] = [
    ["hide Image panel", () => st().setUi({ panelOpen: false })],
    ["hide Slides panel", () => st().setUi({ sidebarOpen: false })],
    ["show Image panel", () => st().setUi({ panelOpen: true })],
    ["show Slides panel", () => st().setUi({ sidebarOpen: true })],
  ];
  out.push({ step: "start", t: "now", ...aspectProbe() });
  for (const [i, [name, act]] of steps.entries()) {
    act();
    await frame();
    await frame();
    out.push({ step: name, t: "next frame", ...aspectProbe() });
    await sleep(300);
    out.push({ step: name, t: "0.3 s", ...aspectProbe() });
    await sleep(1200);
    out.push({ step: name, t: "1.5 s", ...aspectProbe() });
    await stage(`panels-${i + 1}`, 2500);
  }
  await save();
}

/** README screenshots: staged scenes in the real app (the shell script captures the window at each stage) */
async function readmeShots() {
  const v = getActiveViewer();
  // 1. the slide with its annotations, zoomed onto them
  const items = st().annotations.items;
  if (v && items.length) {
    const { boundsNm } = await import("../lib/annotations");
    const bs = items.map((x) => boundsNm(x));
    const b = { minX: Math.min(...bs.map((q) => q.x0)), minY: Math.min(...bs.map((q) => q.y0)), maxX: Math.max(...bs.map((q) => q.x1)), maxY: Math.max(...bs.map((q) => q.y1)) };
    const info = v.info;
    if (b && info) {
      const toImg = (x: number, y: number) => ({ x: (x - info.xOffsetNm) / (info.mppX * 1000) + info.width / 2, y: (y - info.yOffsetNm) / (info.mppY * 1000) + info.height / 2 });
      const a = toImg(b.minX, b.minY), c = toImg(b.maxX, b.maxY);
      const padX = (c.x - a.x) * 0.35 + 3000, padY = (c.y - a.y) * 0.35 + 3000;
      const item = (v.viewer as unknown as { world: { getItemAt(i: number): { imageToViewportRectangle(x: number, y: number, w: number, h: number): unknown } } }).world.getItemAt(0);
      (v.viewer.viewport as unknown as { fitBounds(r: unknown, i: boolean): void }).fitBounds(item.imageToViewportRectangle(a.x - padX, a.y - padY, c.x - a.x + 2 * padX, c.y - a.y + 2 * padY), true);
    }
  }
  st().select(items[0] ? [items[0].id] : []);
  await sleep(2500);
  await stage("readme-annotations", 9000);
  st().select([]);

  // 2. the right-click menu over the slide
  const canvas = document.querySelector(".openseadragon-canvas")!;
  const r = canvas.getBoundingClientRect();
  canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + r.width * 0.55, clientY: r.top + r.height * 0.35, button: 2 }));
  await sleep(400);
  const first = document.querySelector<HTMLElement>(".ctx-menu .ctx-item");
  first?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  first?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await sleep(600);
  await stage("readme-menu", 9000);
  st().setUi({ menu: null });

  // 3. the Adjust tab: stain detected, haematoxylin only
  st().setUi({ panelOpen: true, panelTab: "adjust" });
  const auto = await import("../lib/filters/auto");
  await auto.detectStain().catch(() => null);
  st().setFilterParams({ stain: { mode: "he", channel: 0, vectors: null } });
  await sleep(2500);
  await stage("readme-adjust", 9000);
  st().setFilterParams({ stain: { mode: "none", channel: -1, vectors: null } });
  st().setUi({ panelTab: "annotations" });
}

async function run() {
  await sleep(1500);
  await openFolder(dir);
  const scan = await waitFor("scan", () => !st().browser.scanning && st().browser.scan);
  report.scanned = scan.entries.map((e) => ({ name: e.name, annotationCount: e.annotationCount ?? null }));
  const want = new URLSearchParams(location.search).get("open");
  const entry = (want && scan.entries.find((e) => e.name === want)) || scan.entries[0];
  if (!entry) throw new Error("no slide found in the smoke folder");
  openEntry(entry);
  const info = await waitFor("slide info", () => st().slide.info, 60000);
  report.slide = { width: info.width, height: info.height, mppX: info.mppX, calibrated: info.calibrated, zPlanes: info.zPlanes?.length };
  await waitFor("annotations file", () => st().annotations.filePath);
  await sleep(800);
  const before = st().annotations.items.map((a) => ({ kind: a.kind, title: a.title }));
  report.loadedAnnotations = before;
  await stage("slide-open", 4000);
  report.viewer = viewerState();
  if (new URLSearchParams(location.search).has("readme")) {
    await readmeShots();
    useSettings.getState().setSection("browser", { lastFolder: null, lastSlide: null });
    report.ok = true;
    return;
  }
  if (new URLSearchParams(location.search).has("panels")) {
    await panelProbe();
    useSettings.getState().setSection("browser", { lastFolder: null, lastSlide: null });
    report.ok = true;
    return;
  }

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
