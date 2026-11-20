// Data safety (verification pass): autosave across slide switches, failed writes, the read-only folder
// fallback, and backend slides released on fast switching. The Tauri backend is replaced by an
// in-memory one through window.__TAURI_INTERNALS__.
import { eq, ok, test } from "./harness";
import { useStore } from "../src/lib/store";
import { loadAnnotationFile, saveNow } from "../src/lib/autosave";
import { addAnnotation, makeAnnotation } from "../src/lib/annotations";
import { parseNdpa } from "../src/lib/ndpa";
import type { SlideInfo } from "../src/lib/types";

interface Fake {
  files: Map<string, string>;
  readOnlyDirs: Set<string>;
  failWrites: number;
  writes: string[];
  open: Map<string, number>;
  closed: number[];
  delay: (path: string) => number;
}
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/"));

function install(): Fake {
  const f: Fake = { files: new Map(), readOnlyDirs: new Set(), failWrites: 0, writes: [], open: new Map(), closed: [], delay: () => 0 };
  let next = 0;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  w.__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: async (cmd: string, a: Record<string, unknown>) => {
      switch (cmd) {
        case "open_slide": {
          const path = a.path as string;
          await new Promise((r) => setTimeout(r, f.delay(path)));
          let id = f.open.get(path);
          if (id === undefined) f.open.set(path, (id = ++next));
          const info: Partial<SlideInfo> = { id, path, width: 1000, height: 1000, mppX: 0.25, mppY: 0.25, xOffsetNm: 0, yOffsetNm: 0, zPlanes: [{ index: 0, offsetNm: null, label: "Z 0" }], levels: [], associated: [], calibrated: true, tileSize: 256, maxLevel: 10, format: "fake", vendor: null };
          return info;
        }
        case "close_slide": {
          const id = a.id as number;
          f.closed.push(id);
          for (const [p, i] of f.open) if (i === id) f.open.delete(p);
          return true;
        }
        case "annotation_paths": {
          const sp = a.slidePath as string;
          const primary = `${sp}.ndpa`;
          const fallback = `/appdata/annotations/${sp.replace(/\//g, "_")}.ndpa`;
          return { primary, primaryExists: f.files.has(primary), primaryWritable: !f.readOnlyDirs.has(dirOf(sp)), fallback, fallbackExists: f.files.has(fallback) };
        }
        case "read_text": {
          const t = f.files.get(a.path as string);
          if (t === undefined) throw new Error("not found");
          return t;
        }
        case "write_text": {
          const p = a.path as string;
          if (f.failWrites > 0) {
            f.failWrites--;
            throw new Error("disk full");
          }
          if (f.readOnlyDirs.has(dirOf(p))) throw new Error("read-only");
          f.writes.push(p);
          f.files.set(p, a.contents as string);
          return null;
        }
        default:
          return null;
      }
    },
  };
  useStore.getState().registerFlush("annotations", saveNow);
  return f;
}
function uninstall() {
  useStore.getState().registerFlush("annotations", null);
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}
async function open(path: string) {
  await useStore.getState().openSlide(path);
  await loadAnnotationFile(path);
}
const pin = (title: string) => {
  const st = useStore.getState();
  addAnnotation(makeAnnotation("pin", [{ x: 100, y: 200 }], { color: "#00ff00", items: st.annotations.items, doc: st.annotations.doc, title }));
};
const titles = (f: Fake, p: string) => (f.files.has(p) ? parseNdpa(f.files.get(p)!).map((r) => r.title) : null);

test("data safety: switching slides mid-edit saves to the slide that was edited", async () => {
  const f = install();
  try {
    await open("/c/A.ndpi");
    pin("on A");
    eq(useStore.getState().annotations.save, "dirty", "edit is pending (debounced)");
    await open("/c/B.ndpi");
    eq(titles(f, "/c/A.ndpi.ndpa"), ["on A"], "A's pin was flushed to A's file before the switch");
    ok(!f.files.has("/c/B.ndpi.ndpa"), "nothing written for B");
    eq(useStore.getState().annotations.items.length, 0, "B starts with no annotations");
    pin("on B");
    await open("/c/A.ndpi");
    eq(titles(f, "/c/B.ndpi.ndpa"), ["on B"], "B's pin went to B's file");
    eq(titles(f, "/c/A.ndpi.ndpa"), ["on A"], "A's file still holds only A's pin");
    eq(useStore.getState().annotations.items.map((a) => a.title), ["on A"], "reopening A shows A's pin");
  } finally {
    uninstall();
  }
});

test("data safety: a failed save is retried when the slide is switched", async () => {
  const f = install();
  try {
    await open("/d/A.ndpi");
    pin("keep me");
    f.failWrites = 2; // the primary write and the app-data fallback both fail
    await saveNow();
    eq(useStore.getState().annotations.save, "error", "the failure is reported");
    await open("/d/B.ndpi");
    const saved = titles(f, "/d/A.ndpi.ndpa") ?? titles(f, [...f.files.keys()].find((k) => k.includes("A.ndpi"))!);
    eq(saved, ["keep me"], "the edit was written on the switch instead of being dropped");
  } finally {
    uninstall();
  }
});

test("data safety: a read-only folder saves to app data and never touches the original", async () => {
  const f = install();
  const orig = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<annotations>\n\t<ndpviewstate id="1">\n\t\t<title>teacher</title>\n\t\t<annotation type="pin" displayname="AnnotatePin" color="#00ff00">\n\t\t\t<x>1</x>\n\t\t\t<y>2</y>\n\t\t</annotation>\n\t</ndpviewstate>\n</annotations>\n`;
  f.files.set("/ro/A.ndpi.ndpa", orig);
  f.readOnlyDirs.add("/ro");
  try {
    await open("/ro/A.ndpi");
    eq(useStore.getState().annotations.items.map((a) => a.title), ["teacher"], "the read-only folder's file is shown");
    pin("mine");
    await saveNow();
    eq(f.files.get("/ro/A.ndpi.ndpa"), orig, "the original is untouched");
    const fb = useStore.getState().annotations.filePath!;
    ok(fb.startsWith("/appdata/"), `saved in app data (${fb})`);
    eq(titles(f, fb), ["teacher", "mine"], "the app-data copy has both");
    await open("/ro/B.ndpi");
    await open("/ro/A.ndpi");
    eq(useStore.getState().annotations.items.map((a) => a.title), ["teacher", "mine"], "reopening reads the app-data copy");
  } finally {
    uninstall();
  }
});

test("data safety: stepping quickly through slides closes every slide that isn't shown", async () => {
  const f = install();
  try {
    f.delay = (p) => (p.endsWith("A.ndpi") ? 30 : p.endsWith("B.ndpi") ? 15 : 1);
    const st = useStore.getState();
    await Promise.all([st.openSlide("/e/A.ndpi"), st.openSlide("/e/B.ndpi"), st.openSlide("/e/C.ndpi")]);
    eq(useStore.getState().slide.info?.path, "/e/C.ndpi", "the last one chosen is shown");
    eq([...f.open.keys()], ["/e/C.ndpi"], "only the shown slide is still open in the backend");
    await Promise.all([st.openSlide("/e/A.ndpi"), st.openSlide("/e/C.ndpi")]);
    eq(useStore.getState().slide.info?.path, "/e/C.ndpi", "C again");
    eq([...f.open.keys()], ["/e/C.ndpi"], "re-choosing the shown slide doesn't close it");
    await st.closeSlide();
    eq(f.open.size, 0, "closing the slide releases it");
  } finally {
    uninstall();
  }
});
