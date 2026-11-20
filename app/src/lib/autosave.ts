/**
 * Annotation file lifecycle. Owner: annotations (CONTRACTS.md).
 *  - when a slide opens (slide.openNonce): find its .ndpa (`annotationPaths`): `<slide>.ndpa` next to the
 *    slide, or the app-data fallback copy when the slide's folder is read-only; parse it (lib/ndpa.ts) into
 *    annotations.items / doc / filePath;
 *  - autosave settings.annotations.autosaveMs after the last change (annotations.save === "dirty"), atomic
 *    with a .bak (writeText(path, xml, true)); a failed write next to the slide falls back to app data;
 *  - registers a flusher so slide switches, quit and updates never lose edits;
 *  - "Export .ndpa…" (menu export_ndpa) writes a copy wherever the user picks.
 * A file that can't be parsed is never overwritten: the panel says so, and Export still works.
 */
import { useEffect } from "react";
import * as backend from "./backend";
import { useStore } from "./store";
import { useSettings } from "./settings";
import { useMenuEvent } from "./menu";
import { emptyNdpa, loadNdpa, serializeNdpa, type NdpaDocument } from "./ndpa";
import { useAnnUi } from "./annotations";
import type { Annotation, AnnotationPaths } from "./types";

/** largest .ndpa we read (real ones are a few KB; freehand outlines can be bigger) */
const MAX_NDPA_BYTES = 32 * 1024 * 1024;

const READ_ONLY_NOTICE = "The slide's folder is read-only, so annotations are saved in the app's data folder. Use Export .ndpa… to put a copy elsewhere.";

/** which file to read and which to write, given what exists (pure; tested) */
export function choosePaths(p: AnnotationPaths): { read: string | null; write: string; fallback: boolean } {
  if (!p.primaryWritable) return { read: p.fallbackExists ? p.fallback : p.primaryExists ? p.primary : null, write: p.fallback, fallback: true };
  return { read: p.primaryExists ? p.primary : p.fallbackExists ? p.fallback : null, write: p.primary, fallback: false };
}

/** state of the open slide's file (module-level: one slide is open at a time) */
let ctx: { slidePath: string; fallback: string | null; usingFallback: boolean; blocked: boolean } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> | null = null;

const docOf = () => (useStore.getState().annotations.doc as NdpaDocument | null) ?? emptyNdpa();

/** read the open slide's .ndpa into the store (exported for tests; the hook calls it on every open) */
export async function loadAnnotationFile(slidePath: string) {
  ctx = null;
  useAnnUi.setState({ hidden: [], notice: null, loadError: null, jump: null });
  let paths: AnnotationPaths;
  try {
    paths = await backend.annotationPaths(slidePath);
  } catch (e) {
    useStore.getState().setAnnotations({ saveError: `Can't find where to save annotations: ${e}` });
    return;
  }
  const { read, write, fallback } = choosePaths(paths);
  let doc: NdpaDocument = emptyNdpa();
  let items: Annotation[] = [];
  let blocked = false;
  if (read) {
    try {
      const r = loadNdpa(await backend.readText(read, MAX_NDPA_BYTES));
      doc = r.doc;
      items = r.items;
    } catch (e) {
      blocked = true;
      useAnnUi.setState({ loadError: `Couldn't read ${backend.basename(read)} (${e instanceof Error ? e.message : e}). It won't be overwritten; new annotations can be saved with Export .ndpa….` });
    }
  }
  if (useStore.getState().slide.path !== slidePath) return; // another slide was opened meanwhile
  ctx = { slidePath, fallback: paths.fallback, usingFallback: fallback, blocked };
  if (fallback) {
    useAnnUi.setState({ notice: READ_ONLY_NOTICE });
    useStore.getState().setUi({ toast: { text: "Read-only folder: annotations are saved in the app's data folder.", kind: "info" } });
  }
  const a = useStore.getState().annotations;
  // anything drawn while the file was loading is kept (appended)
  useStore.getState().setAnnotations({ items: [...items, ...a.items], doc, filePath: write, undo: [], redo: [], save: a.items.length ? "dirty" : "idle", saveError: null });
}

/** write the current annotations now (no-op when nothing changed) */
export async function saveNow(): Promise<void> {
  if (saving) await saving.catch(() => {});
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const st = useStore.getState();
  const a = st.annotations;
  // "error": the last write failed, so the edits are still unsaved: try again (e.g. when the slide is switched)
  if (!ctx || ctx.blocked || ctx.slidePath !== st.slide.path || !a.filePath || (a.save !== "dirty" && a.save !== "error")) return;
  const items = a.items;
  const xml = serializeNdpa(docOf(), items);
  const c = ctx;
  st.setAnnotations({ save: "saving" });
  saving = (async () => {
    let path = a.filePath!;
    try {
      await backend.writeText(path, xml, true);
    } catch (e) {
      // e.g. the file itself is read-only: keep the work in app data and say so
      if (!c.usingFallback && c.fallback) {
        path = c.fallback;
        await backend.writeText(path, xml, true);
        c.usingFallback = true;
        useAnnUi.setState({ notice: `Couldn't save next to the slide (${e}). Annotations are saved in the app's data folder instead.` });
        if (useStore.getState().slide.path === c.slidePath) useStore.getState().setAnnotations({ filePath: path });
      } else throw e;
    }
  })();
  try {
    await saving;
    const now = useStore.getState().annotations;
    if (useStore.getState().slide.path === c.slidePath && now.save === "saving")
      useStore.getState().setAnnotations({ save: now.items === items ? "saved" : "dirty", saveError: null });
  } catch (e) {
    if (useStore.getState().slide.path === c.slidePath) useStore.getState().setAnnotations({ save: "error", saveError: String(e) });
  } finally {
    saving = null;
  }
}

/** "Export .ndpa…": write the current annotations to a file the user picks */
export async function exportNdpa(): Promise<void> {
  const st = useStore.getState();
  if (!st.slide.path) return;
  const name = `${backend.basename(st.slide.path)}.ndpa`;
  const picked = await backend.pickSavePath(name, [{ name: "NDP.view annotations", extensions: ["ndpa"] }]);
  if (!picked) return;
  const path = backend.withExt(picked, "ndpa");
  try {
    await backend.writeText(path, serializeNdpa(docOf(), st.annotations.items), false);
    st.setUi({ toast: { text: `Exported ${backend.basename(path)}`, kind: "info" } });
  } catch (e) {
    st.setUi({ toast: { text: `Export failed: ${e}`, kind: "error" } });
  }
}

/** mounted once by App.tsx */
export function useAnnotationFile(): void {
  const openNonce = useStore((s) => s.slide.openNonce);
  const path = useStore((s) => s.slide.path);
  const infoPath = useStore((s) => s.slide.info?.path ?? null);
  const save = useStore((s) => s.annotations.save);
  const items = useStore((s) => s.annotations.items);
  const delay = useSettings((s) => s.s.annotations.autosaveMs);

  useMenuEvent("export_ndpa", () => void exportNdpa());

  useEffect(() => {
    useStore.getState().registerFlush("annotations", saveNow);
    return () => useStore.getState().registerFlush("annotations", null);
  }, []);

  // a slide opened: read its annotations
  useEffect(() => {
    if (!infoPath) {
      ctx = null;
      return;
    }
    void loadAnnotationFile(infoPath);
  }, [openNonce, infoPath]);

  // the slide was closed / switched: forget the file
  useEffect(() => {
    if (!path) ctx = null;
  }, [path]);

  // debounced autosave
  useEffect(() => {
    if (save !== "dirty") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void saveNow(), Math.max(200, delay || 1000));
    return () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
  }, [save, items, delay]);
}
