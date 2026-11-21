#!/usr/bin/env node
/**
 * Accessibility audit (WCAG 2.1 A/AA) of the app in a plain browser: `npm run test:a11y`.
 *
 * It starts its own Vite dev server (port A11Y_PORT, default 5191; never 1420 or 1437) unless
 * A11Y_URL points at one already running, loads the app in headless Chromium with a stand-in for the
 * Tauri backend (a fake folder of two slides with generated tiles and one pin), and then:
 *
 *  1. runs axe-core (tags wcag2a, wcag2aa, wcag21a, wcag21aa) on every screen: the start screen, the
 *     open slide, the right-click menu and a submenu, the annotations and Adjust panels, the help panel,
 *     the snapshot dialog, and Preferences (every pane), in normal and high-contrast display;
 *  2. does the study tasks with the keyboard only (open a folder, open a slide, keyboard cursor, place
 *     and rename a pin, measure, outline, zoom, rotate, change a filter, export a snapshot) and checks
 *     the focus is never lost on <body> after a menu or dialog closes and that Tab always leaves the slide.
 *
 * It exits 1 when axe finds a violation or a keyboard check fails. Stops only the server it started.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "../..");
const PORT = Number(process.env.A11Y_PORT || 5191);
if (PORT === 1420 || PORT === 1437) throw new Error("ports 1420 and 1437 belong to the Tauri dev apps");
const BASE = process.env.A11Y_URL || `http://localhost:${PORT}/`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const verbose = process.argv.includes("--verbose");

// ---------------------------------------------------------------- dev server

let server = null;
async function up(url) {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}
async function startServer() {
  if (process.env.A11Y_URL) return;
  if (await up(BASE)) throw new Error(`port ${PORT} is busy; set A11Y_PORT to a free port`);
  server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: appDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 100; i++) {
    if (await up(BASE)) return;
    await sleep(200);
  }
  throw new Error("vite did not start");
}
function stopServer() {
  if (!server) return;
  try {
    process.kill(-server.pid, "SIGTERM"); // its own process group only
  } catch {
    /* already gone */
  }
  server = null;
}

// ---------------------------------------------------------------- the Tauri stand-in (runs in the page)

function tauriMock({ tileBase }) {
  const W = 40000,
    H = 30000;
  const slide = (p, i) => ({
    id: i + 1,
    path: p,
    tileSize: 256,
    maxLevel: Math.ceil(Math.log2(Math.max(W, H))),
    format: "openslide",
    vendor: "hamamatsu",
    width: W,
    height: H,
    mppX: 0.25,
    mppY: 0.25,
    calibrated: true,
    xOffsetNm: 0,
    yOffsetNm: 0,
    levels: [{ width: W, height: H, downsample: 1 }],
    zPlanes: [
      { index: 0, offsetNm: 0, label: "0" },
      { index: 1, offsetNm: 1000, label: "+1 µm" },
    ],
    associated: [],
  });
  const entries = [
    { path: "/Course/Kidney.ndpi", name: "Kidney.ndpi", dir: "", ext: ".ndpi", size: 9.1e8, modifiedMs: 1.7e12, annotationPath: "/Course/Kidney.ndpi.ndpa" },
    { path: "/Course/Liver/Liver.svs", name: "Liver.svs", dir: "Liver", ext: ".svs", size: 4.2e8, modifiedMs: 1.7e12, annotationPath: null },
  ];
  const ndpa = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<annotations>
	<ndpviewstate id="1">
		<title>Q1</title>
		<details/>
		<coordformat>nanometers</coordformat>
		<lens>10</lens>
		<x>0</x><y>0</y><z>0</z>
		<showtitle>1</showtitle>
		<showhistogram>0</showhistogram>
		<showlineprofile>0</showlineprofile>
		<annotation type="pin" displayname="AnnotatePin" color="#00ff00">
			<x>100000</x><y>-50000</y>
			<icon>pingreen</icon><stricon>iconpingreen</stricon>
		</annotation>
	</ndpviewstate>
</annotations>
`;
  const files = new Map([["/Course/Kidney.ndpi.ndpa", ndpa]]);
  const fit = (w, h, max) => {
    const s = Math.min(1, max / Math.max(w, h, 1));
    return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
  };
  const picture = async (w, h, type) => {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext("2d");
    g.fillStyle = "#f4dbe6";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#7a3b8f";
    for (let i = 0; i < 40; i++) {
      g.beginPath();
      g.arc((i * 97) % w, (i * 53) % h, Math.max(2, w / 30), 0, 7);
      g.fill();
    }
    if (type === "rgba") return g.getImageData(0, 0, w, h).data.buffer;
    return (await (await c.convertToBlob({ type: "image/jpeg" })).arrayBuffer());
  };
  let cb = 0;
  const callbacks = new Map();
  window.__SV_TILE_BASE__ = tileBase;
  // the app's own module instances: after an edit Vite serves them as /src/x.ts?t=…, a different module
  window.__svMod = (p) => {
    const hit = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => new URL(n).pathname === p)
      .pop();
    return import(/* @vite-ignore */ hit ?? p);
  };
  window.__SV_A11Y_AUDIT__ = { saved: [] };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(f) {
      const id = ++cb;
      callbacks.set(id, f);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc: (p) => p,
    async invoke(cmd, args = {}) {
      switch (cmd) {
        case "plugin:dialog|open":
          return "/Course";
        case "plugin:dialog|save":
          return "/Course/snapshot.png";
        case "scan_folder":
          return { root: args.dir, entries, errors: [] };
        case "supported_extensions":
          return [".ndpi", ".svs", ".tif", ".tiff", ".czi", ".jpg", ".png"];
        case "open_slide": {
          const i = entries.findIndex((e) => e.path === args.path);
          if (i < 0) throw new Error("not a slide");
          return slide(args.path, i);
        }
        case "slide_info":
          return null;
        case "close_slide":
          return true;
        case "slide_z_planes":
          return slide("", 0).zPlanes;
        case "slide_thumbnail":
          return picture(args.maxPx || 256, Math.round(((args.maxPx || 256) * 3) / 4), "jpeg");
        case "slide_overview": {
          const [w, h] = fit(W, H, args.maxPx);
          return picture(w, h, args.format || "rgba");
        }
        case "slide_region":
          return picture(args.outWidth, args.outHeight, args.format || "jpeg");
        case "slide_associated":
          throw new Error("none");
        case "annotation_paths":
          return {
            primary: `${args.slidePath}.ndpa`,
            primaryExists: files.has(`${args.slidePath}.ndpa`),
            primaryWritable: true,
            fallback: `/AppData/${args.slidePath.split("/").pop()}.ndpa`,
            fallbackExists: false,
          };
        case "read_text":
          if (files.has(args.path)) return files.get(args.path);
          throw new Error(`no file ${args.path}`);
        case "write_text":
          files.set(args.path, args.contents);
          window.__SV_A11Y_AUDIT__.saved.push(args.path);
          return null;
        case "write_bytes":
        case "save_png":
          window.__SV_A11Y_AUDIT__.saved.push(cmd);
          return null;
        case "path_exists":
          return true;
        case "list_files":
          return [];
        case "open_preferences":
        case "open_help":
          // use the in-page fallbacks (the modal and the help panel)
          throw new Error("no windows in the audit");
        default:
          return null;
      }
    },
  };
}

// ---------------------------------------------------------------- reporting

const results = [];
const failures = [];
async function audit(page, name, opts = {}) {
  let b = new AxeBuilder({ page }).withTags(TAGS);
  if (opts.include) b = b.include(opts.include);
  const r = await b.analyze();
  results.push({ name, violations: r.violations });
  const n = r.violations.reduce((k, v) => k + v.nodes.length, 0);
  console.log(`${r.violations.length ? "FAIL" : "PASS"} axe: ${name}${r.violations.length ? ` (${r.violations.length} rules, ${n} nodes)` : ""}`);
  for (const v of r.violations) {
    console.log(`     ${v.id} [${v.impact}] ${v.help}`);
    for (const node of v.nodes.slice(0, verbose ? 50 : 4)) console.log(`       ${node.target.join(" ")}${verbose ? `\n         ${node.failureSummary?.replace(/\n/g, "\n         ")}` : ""}`);
    if (!verbose && v.nodes.length > 4) console.log(`       … ${v.nodes.length - 4} more`);
  }
}
/** A11Y_SHOTS=<folder>: save screenshots there for a look by eye */
async function shot(page, name) {
  if (!process.env.A11Y_SHOTS) return;
  await page.screenshot({ path: path.join(process.env.A11Y_SHOTS, `${name}.png`) });
}
function check(ok, what, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} keys: ${what}${!ok && detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(what);
}

const focused = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return "body";
    const name = a.getAttribute("aria-label") || a.textContent?.trim().slice(0, 40) || "";
    return `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ""}${a.className && typeof a.className === "string" ? `.${a.className.split(" ")[0]}` : ""} ${a.getAttribute("role") || ""} "${name}"`;
  });
const onSlide = (page) => page.evaluate(() => !!document.activeElement?.closest?.(".openseadragon-container"));
const lastAnnouncements = (page) => page.evaluate(() => [...document.querySelectorAll(".sv-live")].map((e) => e.textContent).join(" | "));

async function tabUntil(page, pred, max = 60, back = false) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    if (await page.evaluate(() => document.activeElement && document.activeElement !== document.body)) if (await page.evaluate(pred)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- the run

async function main() {
  await startServer();
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    const tileBase = new URL("/__tiles", BASE).href;
    await ctx.addInitScript(tauriMock, { tileBase });
    // tiles: any small JPEG will do
    const tile = Buffer.from(
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z",
      "base64",
    );
    await ctx.route(`${tileBase}/**`, (r) => r.fulfill({ status: 200, contentType: "image/jpeg", body: tile }));

    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(BASE);
    await page.waitForSelector(".app-shell");
    await sleep(500);

    // ============ axe on every screen (A11Y_ONLY=keys skips it, A11Y_ONLY=axe skips the keyboard walk)
    const only = process.env.A11Y_ONLY;
    if (only !== "keys") await axeScreens(ctx, page);
    if (only !== "axe") await keyboardWalk(page);
    check(!errors.length, "no page errors", errors.join("; "));
  } finally {
    await browser.close();
  }
}

async function axeScreens(ctx, page) {
  {
    await audit(page, "start screen");

    // open the folder and the first slide (keyboard: covered below; here the quick way)
    await page.evaluate(async () => (await window.__svMod("/src/lib/browser.ts")).openFolder("/Course"));
    await page.waitForSelector('[role="treeitem"]');
    await audit(page, "slide browser with a folder");
    await page.evaluate(async () => {
      const b = await window.__svMod("/src/lib/browser.ts");
      const { useStore } = await window.__svMod("/src/lib/store.ts");
      const e = useStore.getState().browser.scan.entries[0];
      await b.openEntry(e);
    });
    await page.waitForFunction(() => document.querySelector(".openseadragon-canvas"));
    await sleep(1500);
    await audit(page, "slide open, annotations panel");

    // right-click menu and a submenu
    const box = await page.locator(".openseadragon-canvas").boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await page.waitForSelector('[role="menu"]');
    await audit(page, "right-click menu");
    const sub = page.locator('[role="menu"] [aria-haspopup="menu"], [role="menu"] [aria-haspopup="true"]').first();
    if (await sub.count()) {
      await sub.hover();
      await sleep(400);
      await audit(page, "right-click submenu");
    } else check(false, "the slide menu has a submenu");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // the annotation's own menu
    await page.evaluate(async () => {
      const { useStore } = await window.__svMod("/src/lib/store.ts");
      const s = useStore.getState();
      s.select([s.annotations.items[0].id]);
    });
    await page.locator(".openseadragon-canvas").focus();
    await page.keyboard.press("Shift+F10");
    await page.waitForSelector('[role="menu"]');
    await audit(page, "annotation menu (Shift+F10)");
    await page.keyboard.press("Escape");

    // Adjust panel
    await page.locator('[role="tab"]', { hasText: /adjust/i }).click();
    await sleep(300);
    await audit(page, "adjust panel");
    await page.locator('[role="tab"]', { hasText: /annotation/i }).click();

    // tool bar and zoom bar on (they're off by default)
    await page.evaluate(async () => {
      const { useSettings } = await window.__svMod("/src/lib/settings.ts");
      useSettings.getState().setSection("viewer", { showToolbar: true, showZoomBar: true });
    });
    await sleep(300);
    await audit(page, "slide with tool bar and zoom bar");

    // snapshot dialog
    await page.keyboard.press("Shift+S");
    await sleep(400);
    if (await page.locator(".modal").count()) {
      await audit(page, "snapshot dialog");
      await page.keyboard.press("Escape");
    } else check(false, "Shift+S opens the snapshot dialog");

    // help panel
    await page.evaluate(async () => (await window.__svMod("/src/lib/backend.ts")).showHelp("shortcuts"));
    await sleep(600);
    await audit(page, "help panel (shortcuts)");
    await page.evaluate(async () => (await window.__svMod("/src/lib/backend.ts")).showHelp("accessibility"));
    await sleep(400);
    await audit(page, "help panel (accessibility)");
    await page.keyboard.press("Escape");
    await sleep(200);

    // Preferences, every pane, as the separate window renders it
    const prefs = await ctx.newPage();
    await prefs.goto(`${BASE}?window=preferences`);
    await prefs.waitForSelector(".prefs-nav");
    const panes = await prefs.locator(".prefs-nav > button:not(.btn)").allTextContents();
    for (let i = 0; i < panes.length; i++) {
      await prefs.locator(".prefs-nav > button:not(.btn)").nth(i).click();
      await sleep(200);
      await audit(prefs, `preferences: ${panes[i].trim()}`);
    }
    // high contrast + larger text
    await prefs.evaluate(async () => {
      const { useSettings } = await window.__svMod("/src/lib/settings.ts");
      useSettings.getState().setSection("a11y", { highContrast: "on", textScale: 1.5, colorBlindSafe: true });
    });
    await sleep(300);
    await audit(prefs, "preferences: Accessibility, high contrast at 150 %");
    await page.reload();
    await page.waitForSelector(".app-shell");
    await sleep(500);
    await audit(page, "start screen, high contrast at 150 %");
    await shot(page, "hc-150");
    // 200 % text (WCAG 1.4.4) with a slide open
    await prefs.evaluate(async () => (await window.__svMod("/src/lib/settings.ts")).useSettings.getState().setSection("a11y", { highContrast: "off", textScale: 2 }));
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.evaluate(async () => (await window.__svMod("/src/lib/browser.ts")).openFolder("/Course"));
    await page.waitForSelector('[role="treeitem"]');
    await page.evaluate(async () => {
      const { useStore } = await window.__svMod("/src/lib/store.ts");
      await (await window.__svMod("/src/lib/browser.ts")).openEntry(useStore.getState().browser.scan.entries[0]);
    });
    await sleep(1200);
    await audit(page, "slide open at 200 % text");
    await shot(page, "text-200");
    await shot(prefs, "prefs-200");
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll("button, [role=tab], [role=treeitem], .ann-main, label")]
        .filter((e) => e.getClientRects().length && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow !== "visible" && getComputedStyle(e).textOverflow !== "ellipsis")
        .map((e) => e.textContent.trim().slice(0, 30)),
    );
    check(clipped.length === 0, "nothing is cut off at 200 % text", clipped.join(" | "));
    await prefs.evaluate(async () => (await window.__svMod("/src/lib/settings.ts")).useSettings.getState().reset());
    await prefs.close();
  }
}

async function keyboardWalk(page) {
  await page.reload();
  await page.waitForSelector(".app-shell");
  await sleep(500);
  const st = (f) => page.evaluate(f);

  // open a folder: Tab to the Open folder button, Enter
  const found = await tabUntil(page, () => /open (a )?folder|choose (a )?folder/i.test(document.activeElement?.textContent || document.activeElement?.getAttribute("aria-label") || ""));
  check(found, "Tab reaches 'Open folder'");
  if (verbose) console.log("     on:", await focused(page));
  if (found) await page.keyboard.press("Enter");
  else await st(async () => (await window.__svMod("/src/lib/browser.ts")).openFolder("/Course"));
  await page.waitForSelector('[role="treeitem"]', { timeout: 5000 });

  // open a slide: Tab into the tree, arrows to the slide, Enter
  const inTree = await tabUntil(page, () => document.activeElement?.getAttribute("role") === "treeitem");
  check(inTree, "Tab reaches the slide tree");
  for (let i = 0; i < 6 && !(await st(() => /Kidney/.test(document.activeElement?.textContent || ""))); i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".openseadragon-canvas"), null, { timeout: 5000 });
  await sleep(1200);
  check(await st(() => /Kidney/.test(document.title)), "the document title names the slide");

  // reach the slide with Tab
  const reached = await tabUntil(page, () => !!document.activeElement?.closest?.(".openseadragon-container"));
  check(reached, "Tab reaches the slide");
  if (verbose) console.log("     cursor before X:", await st(async () => !!(await window.__svMod("/src/lib/annotations.ts")).useAnnUi.getState().kbCursor), await focused(page));
  await page.keyboard.press("x");
  await sleep(100);
  check(await st(async () => !!(await window.__svMod("/src/lib/annotations.ts")).useAnnUi.getState().kbCursor), "X turns the keyboard cursor on");
  check(/keyboard cursor on/i.test(await lastAnnouncements(page)), "the keyboard cursor is announced");

  // zoom, pan, rotate
  const view = () => st(async () => {
    const { getActiveViewer } = await window.__svMod("/src/components/viewer/viewerHandle.ts");
    const v = getActiveViewer().viewer.viewport;
    return { zoom: v.getZoom(true), x: v.getCenter(true).x, rot: v.getRotation() };
  });
  const v0 = await view();
  await page.keyboard.press("+");
  await sleep(300);
  const v1 = await view();
  check(v1.zoom > v0.zoom * 1.5, "+ zooms in");
  await page.keyboard.press("ArrowRight");
  await sleep(200);
  const v2 = await view();
  check(v2.x !== v1.x, "→ pans while the cursor is on");
  await page.keyboard.press(".");
  await sleep(300);
  check((await view()).rot === 90, ". rotates 90°");
  await page.keyboard.press(",");
  await sleep(300);

  // place a pin and name it
  const count = () => st(async () => (await window.__svMod("/src/lib/store.ts")).useStore.getState().annotations.items.length);
  const n0 = await count();
  await page.keyboard.press("p");
  await sleep(300);
  check((await count()) === n0 + 1, "P places a pin at the cursor");
  const editing = await st(() => document.activeElement?.tagName === "INPUT");
  check(editing, "the title editor takes the focus");
  if (editing) {
    await page.keyboard.type("Glomerulus");
    await page.keyboard.press("Enter");
    await sleep(200);
  }
  check(await onSlide(page), "focus returns to the slide after naming", await focused(page));
  check(await st(async () => (await window.__svMod("/src/lib/store.ts")).useStore.getState().annotations.items.some((a) => a.title === "Glomerulus")), "the pin is named");

  // rename with F2
  await page.keyboard.press("F2");
  await sleep(200);
  if (await st(() => document.activeElement?.tagName === "INPUT")) {
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Glomerulus 2");
    await page.keyboard.press("Enter");
    await sleep(200);
  }
  check(await st(async () => (await window.__svMod("/src/lib/store.ts")).useStore.getState().annotations.items.some((a) => a.title === "Glomerulus 2")), "F2 renames");
  await page.keyboard.press("Escape"); // clear the selection

  // measure: R, Space, pan, Space
  const n1 = await count();
  await page.keyboard.press("r");
  await page.keyboard.press(" ");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await sleep(150);
  await page.keyboard.press(" ");
  await sleep(300);
  check((await count()) === n1 + 1, "R, Space, arrows, Space measures");
  // the title editor may open for the ruler: close it
  if (await st(() => document.activeElement?.tagName === "INPUT")) await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // outline: F, Space per point, Shift+Enter
  const n2 = await count();
  await page.keyboard.press("f");
  await page.keyboard.press(" ");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press(" ");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press(" ");
  await page.keyboard.press("Shift+Enter");
  await sleep(300);
  check((await count()) === n2 + 1, "F, Space ×4, Shift+Enter outlines", `${await lastAnnouncements(page)}; focus ${await focused(page)}`);
  if (await st(() => document.activeElement?.tagName === "INPUT")) await page.keyboard.press("Enter");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");

  // menu from the keyboard, and focus after it closes
  await page.locator(".openseadragon-canvas").focus();
  await page.keyboard.press("Shift+F10");
  await sleep(200);
  check(await st(() => document.activeElement?.getAttribute("role")?.startsWith("menuitem")), "Shift+F10 focuses the first menu item");
  await page.keyboard.press("Escape");
  await sleep(100);
  check(await onSlide(page), "focus returns to the slide after the menu closes", await focused(page));

  // N cycles annotations and announces
  await page.keyboard.press("n");
  await sleep(200);
  check(/selected/i.test(await lastAnnouncements(page)), "N selects and announces an annotation");
  await page.keyboard.press("Escape");

  // deleting from the annotation list keeps the focus in the list
  const del = page.locator('.ann-list button[aria-label^="Delete"]').first();
  if (await del.count()) {
    const before = await count();
    await del.focus();
    await page.keyboard.press("Enter");
    await sleep(200);
    check((await count()) === before - 1, "Delete in the list deletes");
    check((await focused(page)) !== "body", "focus is not lost after deleting from the list", await focused(page));
  }

  // Tab leaves the slide (no trap)
  await page.locator(".openseadragon-canvas").focus();
  await page.keyboard.press("Tab");
  check(!(await onSlide(page)), "Tab leaves the slide");
  await page.locator(".openseadragon-canvas").focus();
  await page.keyboard.press("Shift+Tab");
  check(!(await onSlide(page)), "Shift+Tab leaves the slide");

  // filters: Tab to the Adjust tab, arrow to it, change a slider with the keys
  const tab = await tabUntil(page, () => document.activeElement?.getAttribute("role") === "tab");
  check(tab, "Tab reaches the panel tabs");
  if (tab) {
    for (let i = 0; i < 3 && !(await st(() => /adjust/i.test(document.activeElement?.textContent || ""))); i++) await page.keyboard.press("ArrowRight");
    const slider = await tabUntil(page, () => document.activeElement?.type === "range");
    check(slider, "Tab reaches an adjustment slider");
    if (slider) {
      const before = await st(() => document.activeElement.value);
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      const after = await st(() => document.activeElement.value);
      check(before !== after, "arrows change the slider");
      check(await st(() => !!document.activeElement.getAttribute("aria-valuetext") || !!document.activeElement.labels?.length || !!document.activeElement.getAttribute("aria-label")), "the slider has a name / value text");
    }
  }

  // snapshot: Shift+S from the slide, then the dialog by keys
  await page.locator(".openseadragon-canvas").focus();
  await page.keyboard.press("Shift+S");
  await sleep(400);
  const inDialog = await st(() => !!document.activeElement?.closest?.(".modal"));
  check(inDialog, "the snapshot dialog takes the focus", await focused(page));
  // Tab stays in the dialog
  let stayed = true;
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Tab");
    if (!(await st(() => !!document.activeElement?.closest?.(".modal")))) stayed = false;
  }
  check(stayed, "Tab stays inside the open dialog");
  const saveBtn = await tabUntil(page, () => /^(save|export)/i.test(document.activeElement?.textContent?.trim() || ""), 20);
  check(saveBtn, "Tab reaches the dialog's Save button");
  if (saveBtn) {
    await page.keyboard.press("Enter");
    await sleep(1500);
    check(await st(() => window.__SV_A11Y_AUDIT__.saved.some((s) => s === "save_png" || s === "write_bytes")), "the snapshot is saved");
  } else await page.keyboard.press("Escape");
  await sleep(200);
  check(!(await st(() => !!document.querySelector(".modal"))), "the dialog closes");
  check((await focused(page)) !== "body", "focus is not lost after the dialog closes", await focused(page));

  // help and Preferences fallbacks: Esc returns focus
  const help = await tabUntil(page, () => document.activeElement?.getAttribute("aria-label") === "Help", 80);
  if (help) {
    await page.keyboard.press("Enter");
    await sleep(400);
    check(await st(() => !!document.activeElement?.closest?.(".help-panel, .modal, [role=dialog]")), "the help panel takes the focus", await focused(page));
    await page.keyboard.press("Escape");
    await sleep(200);
    check(await st(() => document.activeElement?.getAttribute("aria-label") === "Help"), "Esc returns focus to the Help button", await focused(page));
  } else check(false, "Tab reaches the Help button");

  // Preferences (the in-page fallback outside the app): focus moves in, Esc brings it back
  const prefsBtn = await tabUntil(page, () => document.activeElement?.getAttribute("aria-label") === "Preferences", 80);
  check(prefsBtn, "Tab reaches the Preferences button");
  if (prefsBtn) {
    await page.keyboard.press("Enter");
    await sleep(500);
    check(await st(() => !!document.activeElement?.closest?.("[role=dialog]")), "Preferences takes the focus", await focused(page));
    await audit(page, "preferences dialog (in-page)");
    await page.keyboard.press("Escape");
    await sleep(200);
    check(await st(() => document.activeElement?.getAttribute("aria-label") === "Preferences"), "Esc returns focus to the Preferences button", await focused(page));
  }

  // WCAG 2.1.4: with "single-key shortcuts only on the slide", N on a button does nothing; on the slide it works
  await st(async () => (await window.__svMod("/src/lib/settings.ts")).useSettings.getState().setSection("a11y", { singleKeysOnSlide: true }));
  const sel = () => st(async () => (await window.__svMod("/src/lib/store.ts")).useStore.getState().annotations.selection.join());
  await st(async () => (await window.__svMod("/src/lib/store.ts")).useStore.getState().select([]));
  await page.keyboard.press("n");
  await sleep(100);
  check((await sel()) === "", "single-key shortcuts off the slide are ignored when limited to the slide");
  await page.locator(".openseadragon-canvas").focus();
  await page.keyboard.press("n");
  await sleep(100);
  check((await sel()) !== "", "…and still work on the slide");
  await st(async () => (await window.__svMod("/src/lib/settings.ts")).useSettings.getState().setSection("a11y", { singleKeysOnSlide: false }));
}

main()
  .catch((e) => {
    console.error(e);
    failures.push(String(e));
  })
  .finally(() => {
    stopServer();
    const v = results.reduce((k, r) => k + r.violations.length, 0);
    console.log(`\n${results.length} screens audited, ${v} axe violations; ${failures.length} keyboard checks failed`);
    process.exit(v || failures.length ? 1 : 0);
  });
