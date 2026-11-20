// Tests for the folder browser (lib/browser.ts, lib/thumbs.ts). Owner: browser builder (CONTRACTS.md).
import { eq, ok, test } from "./harness";
import {
  allDirs,
  ancestors,
  buildRows,
  dirCompare,
  displayName,
  fmtSize,
  matchesQuery,
  naturalCompare,
  neighbour,
  noteAnnotationsSaved,
  openFolder,
  revealDir,
  setCollapsed,
  stepSlide,
  summarize,
  toggleDir,
  visibleSlides,
} from "../src/lib/browser";
import { TaskQueue, thumbKey } from "../src/lib/thumbs";
import { useStore } from "../src/lib/store";
import { useSettings } from "../src/lib/settings";
import type { ScanEntry, ScanResult } from "../src/lib/types";

const E = (dir: string, name: string, extra: Partial<ScanEntry> = {}): ScanEntry => ({
  path: `/root/${dir ? `${dir}/` : ""}${name}`,
  name,
  dir,
  ext: name.slice(name.lastIndexOf(".")).toLowerCase(),
  size: 1000,
  modifiedMs: 1,
  annotationPath: null,
  ...extra,
});

const sample = (): ScanEntry[] => [
  E("Week 10", "b.svs"),
  E("Week 2/sub", "c.png"),
  E("", "VMS110.ndpi"),
  E("", "VMS104.ndpi", { annotationPath: "/root/VMS104.ndpi.ndpa", annotationCount: 3 }),
  E("Week 2", "a.tif"),
  E("Only/Deeper", "d.czi"),
];

test("browser: natural order", () => {
  ok(naturalCompare("Slide 2", "slide 10") < 0, "Slide 2 < slide 10");
  ok(naturalCompare("VMS104", "VMS110") < 0, "VMS104 < VMS110");
  ok(naturalCompare("a", "A") !== 0, "ties broken (stable order)");
  ok(dirCompare("", "a") < 0 && dirCompare("a", "a/b") < 0, "root, then a folder, then its subfolders");
  ok(dirCompare("a/b", "a b") < 0, "component-wise, like scan.rs");
  ok(dirCompare("Week 2", "Week 10") < 0, "Week 2 < Week 10");
  eq(ancestors("a/b/c"), ["a", "a/b", "a/b/c"], "ancestors");
  eq(ancestors(""), [], "no ancestors for the root");
});

test("browser: search", () => {
  const e = E("Week 2", "VMS104.ndpi");
  ok(matchesQuery(e, ""), "empty query matches");
  ok(matchesQuery(e, "vms104"), "case-insensitive name");
  ok(matchesQuery(e, "week 104"), "words may match folder and name");
  ok(!matchesQuery(e, "week 105"), "every word must match");
  eq(displayName(e), "VMS104", "extension hidden");
  eq(displayName(E("", ".ndpi")), ".ndpi", "a bare extension stays");
  eq(visibleSlides(sample(), "week").map((x) => x.name), ["a.tif", "c.png", "b.svs"], "filtered, in tree order");
});

test("browser: tree rows", () => {
  const rows = buildRows(sample(), []);
  eq(
    rows.map((r) => (r.kind === "dir" ? `${"  ".repeat(r.depth)}[${r.name}] ${r.count}` : `${"  ".repeat(r.depth)}${r.entry.name}`)),
    ["VMS104.ndpi", "VMS110.ndpi", "[Only] 1", "  [Deeper] 1", "    d.czi", "[Week 2] 2", "  a.tif", "  [sub] 1", "    c.png", "[Week 10] 1", "  b.svs"],
    "slides first, then subfolders; intermediate folders appear",
  );
  const col = buildRows(sample(), ["Week 2", "Only/Deeper"]);
  ok(!col.some((r) => r.kind === "slide" && r.entry.dir.startsWith("Week 2")), "collapsed folder hides its slides");
  ok(col.some((r) => r.kind === "dir" && r.dir === "Week 2" && !r.open), "collapsed folder row stays");
  ok(!col.some((r) => r.kind === "dir" && r.dir === "Week 2/sub"), "and hides its subfolders");
  const q = buildRows(sample(), ["Week 2"], "c.png");
  eq(
    q.map((r) => r.key),
    ["d:Week 2", "d:Week 2/sub", "s:/root/Week 2/sub/c.png"],
    "search shows only matching folders, expanded",
  );
  const root = buildRows([E("", "x.ndpi", { annotationCount: 2, annotationPath: "p" }), E("A", "y.ndpi", { annotationCount: 1, annotationPath: "q" })], []);
  const a = root.find((r) => r.kind === "dir");
  ok(a?.kind === "dir" && a.annotated === 1 && a.count === 1, "folder counts annotated slides");
  eq(allDirs(sample()), ["Only", "Only/Deeper", "Week 2", "Week 2/sub", "Week 10"], "allDirs");
  eq(buildRows([], []), [], "nothing scanned, no rows");
});

test("browser: stepping", () => {
  const list = visibleSlides(sample());
  eq(neighbour(list, null, 1)?.name, "VMS104.ndpi", "from nowhere, next is the first");
  eq(neighbour(list, null, -1)?.name, "b.svs", "from nowhere, previous is the last");
  eq(neighbour(list, "/root/VMS110.ndpi", 1)?.name, "d.czi", "next crosses into a folder");
  eq(neighbour(list, "/root/Week 10/b.svs", 1), null, "no wrap at the end");
  eq(neighbour(list, "/root/VMS104.ndpi", -1), null, "no wrap at the start");
  eq(neighbour([], null, 1), null, "empty list");
});

test("browser: summary and sizes", () => {
  eq(summarize(sample()), { slides: 6, annotated: 1, annotations: 3 }, "summary");
  eq(fmtSize(0), "", "zero");
  eq(fmtSize(999), "999 B", "bytes");
  eq(fmtSize(1_450_000_000), "1.4 GB", "GB");
  eq(fmtSize(250_000_000), "250 MB", "MB");
});

test("browser: store actions (collapse, step, badge)", async () => {
  const st = useStore.getState();
  const realOpen = st.openSlide;
  const opened: string[] = [];
  useStore.setState({
    openSlide: async (p: string) => {
      opened.push(p);
      useStore.getState().setSlide({ path: p });
    },
  });
  try {
    const scan: ScanResult = { root: "/root", entries: visibleSlides(sample()), errors: [] };
    useStore.getState().setBrowser({ root: "/root", scan, query: "", collapsedDirs: [] });
    useStore.getState().setSlide({ path: null });

    toggleDir("Week 2");
    eq(useStore.getState().browser.collapsedDirs, ["Week 2"], "toggle collapses");
    eq(useSettings.getState().s.browser.collapsed["/root"], ["Week 2"], "collapsed folders remembered per root");
    toggleDir("Week 2", false);
    eq(useStore.getState().browser.collapsedDirs, ["Week 2"], "toggle(false) on a collapsed folder is a no-op");
    setCollapsed(["Week 2", "Week 2/sub", "Only"]);
    revealDir("Week 2/sub");
    eq(useStore.getState().browser.collapsedDirs, ["Only"], "revealDir expands the ancestors");

    stepSlide(1);
    eq(opened, ["/root/VMS104.ndpi"], "] with nothing open opens the first slide");
    stepSlide(1);
    stepSlide(1);
    eq(opened.at(-1), "/root/Only/Deeper/d.czi", "steps into folders in tree order");
    eq(useStore.getState().browser.collapsedDirs, [], "the folder of the opened slide is expanded");
    useStore.getState().setSlide({ path: "/root/Week 10/b.svs" });
    const n = opened.length;
    stepSlide(1);
    ok(opened.length === n && useStore.getState().ui.toast?.text.includes("last"), "] on the last slide shows a toast and stays");
    useStore.getState().setBrowser({ query: "week 2" });
    useStore.getState().setSlide({ path: null });
    stepSlide(-1);
    eq(opened.at(-1), "/root/Week 2/sub/c.png", "[ respects the search filter");
    useStore.getState().setBrowser({ query: "" });

    noteAnnotationsSaved("/root/VMS110.ndpi", "/root/VMS110.ndpi.ndpa", 2);
    const e = useStore.getState().browser.scan!.entries.find((x) => x.name === "VMS110.ndpi")!;
    ok(e.annotationPath === "/root/VMS110.ndpi.ndpa" && e.annotationCount === 2, "a save updates the badge");
    const before = useStore.getState().browser.scan;
    noteAnnotationsSaved("/root/VMS110.ndpi", "/root/VMS110.ndpi.ndpa", 2);
    ok(useStore.getState().browser.scan === before, "no change, no new scan object");
    noteAnnotationsSaved("/elsewhere/x.ndpi", "/elsewhere/x.ndpi.ndpa", 1);
    ok(useStore.getState().browser.scan === before, "slides outside the folder are ignored");
  } finally {
    useStore.setState({ openSlide: realOpen });
  }
});

test("browser: openFolder scans and remembers", async () => {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  const calls: string[] = [];
  w.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: { dir?: string }) => {
      calls.push(cmd);
      if (cmd === "scan_folder") {
        if (args.dir === "/bad") throw "no such folder";
        return { root: args.dir, entries: [E("B", "z.svs"), E("", "a.ndpi")], errors: [] } satisfies ScanResult;
      }
      throw new Error(`unexpected ${cmd}`);
    },
    transformCallback: () => 0,
  };
  try {
    useSettings.getState().setSection("browser", { collapsed: { "/course": ["B", "Gone"] } });
    await openFolder("/course");
    const b = useStore.getState().browser;
    ok(calls.includes("scan_folder"), "scan_folder invoked");
    eq(b.scan?.entries.map((x) => x.name), ["a.ndpi", "z.svs"], "entries in tree order");
    ok(!b.scanning && !b.error, "scan finished");
    eq(useSettings.getState().s.browser.lastFolder, "/course", "last folder remembered");
    eq(b.collapsedDirs, ["B"], "collapsed folders restored, vanished ones dropped");
    await openFolder("/bad");
    const b2 = useStore.getState().browser;
    ok(b2.root === "/bad" && b2.error?.includes("no such folder") && !b2.scanning, "scan errors are shown");
  } finally {
    delete w.__TAURI_INTERNALS__;
    useStore.getState().setBrowser({ root: null, scan: null, error: null, collapsedDirs: [] });
  }
});

test("thumbs: queue limits, shares and cancels", async () => {
  const q = new TaskQueue<string>(2);
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const job = (k: string) => () =>
    new Promise<string>((res) => {
      started.push(k);
      gates.set(k, () => res(`img:${k}`));
    });
  const a = q.push("a", job("a"));
  const a2 = q.push("a", job("a"));
  const b = q.push("b", job("b"));
  const c = q.push("c", job("c"));
  const d = q.push("d", job("d"));
  await Promise.resolve();
  await Promise.resolve();
  eq(started, ["a", "b"], "two at a time, duplicates share a job");
  let cancelled = false;
  c.promise.catch(() => (cancelled = true));
  c.cancel();
  gates.get("a")!();
  eq(await a.promise, "img:a", "result");
  eq(await a2.promise, "img:a", "shared result");
  await new Promise((r) => setTimeout(r, 0));
  ok(cancelled, "a waiting job can be cancelled");
  eq(started, ["a", "b", "d"], "the cancelled job never runs");
  gates.get("b")!();
  gates.get("d")!();
  eq([await b.promise, await d.promise], ["img:b", "img:d"], "the rest finish");
  ok(q.inFlight === 0 && q.pending === 0, "queue drained");
  ok(thumbKey(E("", "x.ndpi")) !== thumbKey(E("", "x.ndpi", { modifiedMs: 2 })), "a changed file gets a new thumbnail key");
});
