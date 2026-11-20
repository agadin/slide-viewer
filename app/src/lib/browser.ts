/**
 * Folder browsing logic: open/rescan a parent folder (backend.scanFolder + "scan-progress" events),
 * remember the last folder and collapsed folders (settings.browser), build the tree rows from
 * ScanEntry.dir, name search, natural order, and stepping through slides.
 * Owner: browser (CONTRACTS.md). The UI is components/Browser.tsx; thumbnails are lib/thumbs.ts.
 *
 * CONTRACT: lib/keys.ts calls `stepSlide(±1)`; App/menus call `openFolder()` and `rescan()`.
 */
import { listen } from "@tauri-apps/api/event";
import { hasTauri, pathExists, pickFolder, scanFolder } from "./backend";
import { useSettings } from "./settings";
import { useStore } from "./store";
import type { ScanEntry, ScanProgress, ScanResult } from "./types";

// ---------------------------------------------------------------- ordering

const collator = typeof Intl !== "undefined" ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }) : null;

/** Natural, case-insensitive order ("Slide 2" < "slide 10"), ties broken by the raw string. Mirrors scan.rs. */
export function naturalCompare(a: string, b: string): number {
  const c = collator ? collator.compare(a, b) : a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
  return c || (a < b ? -1 : a > b ? 1 : 0);
}

/** Folder order, component by component (a folder comes right before its own subfolders). */
export function dirCompare(a: string, b: string): number {
  const pa = a ? a.split("/") : [];
  const pb = b ? b.split("/") : [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const c = naturalCompare(pa[i], pb[i]);
    if (c) return c;
  }
  return pa.length - pb.length;
}

export const entryCompare = (a: ScanEntry, b: ScanEntry) => dirCompare(a.dir, b.dir) || naturalCompare(a.name, b.name);

/** "a/b/c" → ["a", "a/b", "a/b/c"]; "" → [] */
export function ancestors(dir: string): string[] {
  if (!dir) return [];
  const parts = dir.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export const parentDir = (dir: string) => (dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "");
export const dirName = (dir: string) => dir.slice(dir.lastIndexOf("/") + 1);

// ---------------------------------------------------------------- search

/** File name without the slide extension: "VMS104.ndpi" → "VMS104" */
export const displayName = (e: Pick<ScanEntry, "name" | "ext">) =>
  e.ext && e.name.toLowerCase().endsWith(e.ext) && e.name.length > e.ext.length ? e.name.slice(0, -e.ext.length) : e.name;

/** Every word of the query must appear in the slide's name or its folder path (case-insensitive). */
export function matchesQuery(e: Pick<ScanEntry, "name" | "dir">, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${e.dir}/${e.name}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The slides in browsing order (search applied): what [ / ] step through. */
export function visibleSlides(entries: ScanEntry[], query = ""): ScanEntry[] {
  return entries.filter((e) => matchesQuery(e, query)).sort(entryCompare);
}

/** The slide `delta` steps from `current` (null at either end; from nowhere, the first/last). */
export function neighbour(list: ScanEntry[], current: string | null, delta: number): ScanEntry | null {
  if (!list.length || !delta) return null;
  const i = current ? list.findIndex((e) => e.path === current) : -1;
  if (i < 0) return delta > 0 ? list[0] : list[list.length - 1];
  return list[i + delta] ?? null;
}

// ---------------------------------------------------------------- tree rows

export type Row =
  | { kind: "dir"; key: string; dir: string; name: string; depth: number; open: boolean; count: number; annotated: number }
  | { kind: "slide"; key: string; entry: ScanEntry; depth: number };

export const slideKey = (path: string) => `s:${path}`;
export const dirKey = (dir: string) => `d:${dir}`;

interface Node {
  dir: string;
  slides: ScanEntry[];
  subdirs: Map<string, Node>;
  count: number;
  annotated: number;
}

/**
 * The flat list of rows the sidebar shows: in each folder its slides first, then its subfolders
 * (the scan order, so [ ] steps in the order you see). With a search, only folders holding
 * matches are shown, all expanded.
 */
export function buildRows(entries: ScanEntry[], collapsed: Iterable<string>, query = ""): Row[] {
  const closed = new Set(collapsed);
  const searching = !!query.trim();
  const root: Node = { dir: "", slides: [], subdirs: new Map(), count: 0, annotated: 0 };
  const nodes = new Map<string, Node>([["", root]]);
  const nodeFor = (dir: string): Node => {
    let n = nodes.get(dir);
    if (n) return n;
    n = { dir, slides: [], subdirs: new Map(), count: 0, annotated: 0 };
    nodes.set(dir, n);
    nodeFor(parentDir(dir)).subdirs.set(dir, n);
    return n;
  };
  for (const e of visibleSlides(entries, query)) {
    nodeFor(e.dir).slides.push(e);
    const has = (e.annotationCount ?? (e.annotationPath ? 1 : 0)) > 0;
    for (const d of ["", ...ancestors(e.dir)]) {
      const n = nodes.get(d)!;
      n.count++;
      if (has) n.annotated++;
    }
  }
  const rows: Row[] = [];
  const walk = (n: Node, depth: number) => {
    for (const e of n.slides) rows.push({ kind: "slide", key: slideKey(e.path), entry: e, depth });
    const subs = [...n.subdirs.values()].sort((a, b) => naturalCompare(dirName(a.dir), dirName(b.dir)));
    for (const s of subs) {
      const open = searching || !closed.has(s.dir);
      rows.push({ kind: "dir", key: dirKey(s.dir), dir: s.dir, name: dirName(s.dir), depth, open, count: s.count, annotated: s.annotated });
      if (open) walk(s, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** every folder that appears in the tree (including folders that only hold subfolders) */
export function allDirs(entries: ScanEntry[]): string[] {
  const s = new Set<string>();
  for (const e of entries) for (const d of ancestors(e.dir)) s.add(d);
  return [...s].sort(dirCompare);
}

/** Totals for the footer. */
export function summarize(entries: ScanEntry[]) {
  let annotated = 0;
  let annotations = 0;
  for (const e of entries) {
    const n = e.annotationCount ?? (e.annotationPath ? 1 : 0);
    if (n > 0) annotated++;
    annotations += e.annotationCount ?? 0;
  }
  return { slides: entries.length, annotated, annotations };
}

/** "1.4 GB" */
export function fmtSize(bytes: number): string {
  if (!bytes) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

// ---------------------------------------------------------------- remembered state (settings.browser)

const MAX_REMEMBERED_ROOTS = 20;

/** collapsed folders remembered for `root` */
export const rememberedCollapsed = (root: string): string[] => useSettings.getState().s.browser.collapsed?.[root] ?? [];

/** remember the collapsed folders of `root` (keeps the most recent few roots) */
export function rememberCollapsed(root: string, dirs: string[]) {
  const prev = useSettings.getState().s.browser.collapsed ?? {};
  if (JSON.stringify(prev[root] ?? []) === JSON.stringify(dirs)) return;
  const next: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(prev).filter(([k]) => k !== root).slice(-(MAX_REMEMBERED_ROOTS - 1))) next[k] = v;
  if (dirs.length) next[root] = dirs;
  useSettings.getState().setSection("browser", { collapsed: next });
}

/** Collapse or expand folders (persisted per root). */
export function setCollapsed(dirs: string[]) {
  const st = useStore.getState();
  const uniq = [...new Set(dirs)].sort(dirCompare);
  st.setBrowser({ collapsedDirs: uniq });
  if (st.browser.root) rememberCollapsed(st.browser.root, uniq);
}

export function toggleDir(dir: string, open?: boolean) {
  const cur = useStore.getState().browser.collapsedDirs;
  const isOpen = !cur.includes(dir);
  const want = open ?? !isOpen;
  if (want === isOpen) return;
  setCollapsed(want ? cur.filter((d) => d !== dir) : [...cur, dir]);
}

/** make sure the folders holding `dir` are expanded */
export function revealDir(dir: string) {
  const cur = useStore.getState().browser.collapsedDirs;
  const need = new Set(ancestors(dir));
  if (cur.some((d) => need.has(d))) setCollapsed(cur.filter((d) => !need.has(d)));
}

// ---------------------------------------------------------------- folder actions

let scanSeq = 0;

/**
 * Choose (dir omitted → folder picker) and scan a parent folder. `restoring` is set when the app
 * reopens the last folder at launch: a missing folder is then reported quietly.
 */
export async function openFolder(dir?: string, opts: { restoring?: boolean } = {}): Promise<void> {
  const root = dir ?? (await pickFolder());
  if (!root) return;
  if (opts.restoring && hasTauri && !(await pathExists(root).catch(() => false))) {
    useStore.getState().setBrowser({ root, scan: null, scanning: false, progress: null, error: `The last folder isn't available: ${root}` });
    return;
  }
  useStore.getState().setBrowser({ root, scanning: true, progress: null, error: null, scan: null, collapsedDirs: rememberedCollapsed(root) });
  useSettings.getState().setSection("browser", { lastFolder: root });
  await rescan();
}

/** Scan the current folder again (keeps the list on screen while it runs). */
export async function rescan(): Promise<void> {
  const { root } = useStore.getState().browser;
  if (!root) return;
  const seq = ++scanSeq;
  const live = () => seq === scanSeq && useStore.getState().browser.root === root;
  useStore.getState().setBrowser({ scanning: true, error: null, progress: { root, folders: 0, found: 0 } });
  let unlisten: (() => void) | null = null;
  if (hasTauri) {
    try {
      unlisten = await listen<ScanProgress>("scan-progress", ({ payload }) => {
        if (live() && payload.root === root) useStore.getState().setBrowser({ progress: payload });
      });
    } catch {
      /* events unavailable: no progress, still scans */
    }
  }
  try {
    const scan = await scanFolder(root);
    if (live()) {
      useStore.getState().setBrowser({ scan: { ...scan, entries: [...scan.entries].sort(entryCompare) }, scanning: false, progress: null });
      // drop remembered collapsed folders that no longer exist
      const dirs = new Set(allDirs(scan.entries));
      const cur = useStore.getState().browser.collapsedDirs;
      if (cur.some((d) => !dirs.has(d))) setCollapsed(cur.filter((d) => dirs.has(d)));
    }
  } catch (e) {
    if (live()) useStore.getState().setBrowser({ scanning: false, progress: null, error: String(e) });
  } finally {
    unlisten?.();
  }
}

/** Open the previous (-1) or next (+1) slide in the browser's order (search applied). */
export function stepSlide(delta: number): void {
  const st = useStore.getState();
  const list = visibleSlides(st.browser.scan?.entries ?? [], st.browser.query);
  if (!list.length) return;
  const next = neighbour(list, st.slide.path, delta);
  if (!next) {
    st.setUi({ toast: { text: delta > 0 ? "That was the last slide in the folder." : "That was the first slide in the folder.", kind: "info" } });
    return;
  }
  if (next.path === st.slide.path) return;
  revealDir(next.dir);
  void st.openSlide(next.path);
}

/** Open a slide from the list (expands its folder). */
export function openEntry(e: ScanEntry) {
  revealDir(e.dir);
  const st = useStore.getState();
  if (st.slide.path !== e.path || st.slide.error) void st.openSlide(e.path);
}

/** Update the scan entry of the open slide after its annotations were saved (badge + count). */
export function noteAnnotationsSaved(slidePath: string, filePath: string | null, count: number) {
  const st = useStore.getState();
  const scan: ScanResult | null = st.browser.scan;
  if (!scan) return;
  const i = scan.entries.findIndex((e) => e.path === slidePath);
  if (i < 0) return;
  const old = scan.entries[i];
  const annotationPath = filePath ?? old.annotationPath;
  if (old.annotationPath === annotationPath && old.annotationCount === count) return;
  const entries = scan.entries.slice();
  entries[i] = { ...old, annotationPath, annotationCount: count };
  st.setBrowser({ scan: { ...scan, entries } });
}
