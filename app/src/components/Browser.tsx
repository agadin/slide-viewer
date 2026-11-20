/**
 * Left sidebar slide browser: choose a parent folder, a collapsible tree mirroring its subfolders,
 * a thumbnail per slide, name search, annotation badges, the current slide highlighted, keyboard
 * navigation, and the last folder (and expanded folders) remembered across launches.
 * Menu "open_folder" / "rescan_folder". Also BrowserPrefs (Preferences ▸ Slide browser).
 * Owner: browser (CONTRACTS.md). Logic: lib/browser.ts; thumbnails: lib/thumbs.ts.
 */
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { basename, hasTauri, isMac, revealFile, supportedExtensions } from "../lib/backend";
import {
  allDirs,
  buildRows,
  dirKey,
  displayName,
  fmtSize,
  noteAnnotationsSaved,
  openEntry,
  openFolder,
  parentDir,
  rescan,
  setCollapsed,
  slideKey,
  summarize,
  toggleDir,
  type Row,
} from "../lib/browser";
import { useMenuEvent } from "../lib/menu";
import { useSettings } from "../lib/settings";
import { useStore } from "../lib/store";
import { clearThumbFailures, useThumb } from "../lib/thumbs";
import type { ScanEntry } from "../lib/types";
import { SearchField } from "./controls";
import { IconPin, IconTri } from "./icons";
import { Check, PrefGroup, PrefRow, Seg } from "./prefsUi";
import "./browser.css";

const revealLabel = isMac ? "Show in Finder" : "Show in Explorer";

// ---------------------------------------------------------------- lazy visibility (one observer for the list)

type Watch = (el: Element, cb: (visible: boolean) => void) => () => void;
const VisibleCtx = createContext<Watch | null>(null);

function useVisibilityWatcher(root: RefObject<HTMLElement | null>): Watch {
  const obs = useRef<IntersectionObserver | null>(null);
  const cbs = useRef(new Map<Element, (v: boolean) => void>());
  useEffect(() => () => obs.current?.disconnect(), []);
  return useCallback<Watch>(
    (el, cb) => {
      if (typeof IntersectionObserver === "undefined") {
        cb(true);
        return () => {};
      }
      if (obs.current && obs.current.root !== root.current) {
        obs.current.disconnect(); // the list was re-created
        obs.current = null;
        cbs.current.clear();
      }
      if (!obs.current)
        obs.current = new IntersectionObserver(
          (items) => {
            for (const it of items) cbs.current.get(it.target)?.(it.isIntersecting);
          },
          { root: root.current, rootMargin: "300px 0px" },
        );
      cbs.current.set(el, cb);
      obs.current.observe(el);
      return () => {
        cbs.current.delete(el);
        obs.current?.unobserve(el);
      };
    },
    [root],
  );
}

function useVisible(ref: RefObject<HTMLElement | null>): boolean {
  const watch = useContext(VisibleCtx);
  const [v, setV] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!watch) return setV(true);
    return watch(el, (x) => x && setV(true)); // once seen, keep it (it's cached anyway)
  }, [watch, ref]);
  return v;
}

// ---------------------------------------------------------------- rows

function Thumb({ entry, size }: { entry: ScanEntry; size: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useVisible(ref);
  const { url, error } = useThumb(entry, visible);
  return (
    <div ref={ref} className={`br-thumb ${url ? "has" : ""}`} style={{ width: size, height: Math.round(size * 0.62) }} title={error ? `No preview: ${error}` : undefined}>
      {url ? <img src={url} alt="" draggable={false} /> : <span className="br-ext">{error ? "—" : entry.ext.slice(1).toUpperCase()}</span>}
    </div>
  );
}

const SlideRow = memo(function SlideRow(p: {
  row: Extract<Row, { kind: "slide" }>;
  current: boolean;
  cursor: boolean;
  thumbSize: number;
  loading: boolean;
  failed: boolean;
  onPick: (r: Row) => void;
  onMenu: (r: Row, e: MouseEvent) => void;
}) {
  const e = p.row.entry;
  const n = e.annotationCount ?? (e.annotationPath ? null : 0);
  return (
    <div
      role="treeitem"
      aria-level={p.row.depth + 1}
      aria-selected={p.current}
      data-key={p.row.key}
      className={`br-row br-slide ${p.current ? "on" : ""} ${p.cursor ? "cur" : ""} ${p.thumbSize ? "" : "compact"}`}
      style={{ paddingLeft: 8 + p.row.depth * 14 }}
      onClick={() => p.onPick(p.row)}
      onContextMenu={(ev) => p.onMenu(p.row, ev)}
      title={`${e.dir ? `${e.dir}/` : ""}${e.name}`}
    >
      {p.thumbSize > 0 && <Thumb entry={e} size={p.thumbSize} />}
      <div className="br-text">
        <div className="br-name">{displayName(e)}</div>
        {p.thumbSize > 0 && (
          <div className="br-meta">
            {e.ext.slice(1).toUpperCase()}
            {e.size ? ` · ${fmtSize(e.size)}` : ""}
            {p.loading && " · opening…"}
            {p.failed && <span className="warn"> · can't open</span>}
          </div>
        )}
      </div>
      {e.annotationPath && n !== 0 && (
        <span className="br-badge" title={n === null ? "Has an annotation file" : `${n} annotation${n === 1 ? "" : "s"} saved`}>
          <IconPin />
          {n ?? ""}
        </span>
      )}
    </div>
  );
});

const DirRow = memo(function DirRow(p: { row: Extract<Row, { kind: "dir" }>; cursor: boolean; onPick: (r: Row) => void; onMenu: (r: Row, e: MouseEvent) => void }) {
  const r = p.row;
  return (
    <div
      role="treeitem"
      aria-level={r.depth + 1}
      aria-expanded={r.open}
      data-key={r.key}
      className={`br-row br-dir ${p.cursor ? "cur" : ""}`}
      style={{ paddingLeft: 6 + r.depth * 14 }}
      onClick={() => p.onPick(r)}
      onContextMenu={(ev) => p.onMenu(r, ev)}
      title={r.dir}
    >
      <span className="br-tri">
        <IconTri open={r.open} />
      </span>
      <svg className="br-folder-ic" width="14" height="14" viewBox="0 0 16 16" aria-hidden>
        <path d="M1.5 4.5v8h13v-7h-7l-1.5-1.5h-4.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
      <span className="br-name">{r.name}</span>
      <span className="br-count" title={`${r.count} slide${r.count === 1 ? "" : "s"}${r.annotated ? `, ${r.annotated} with annotations` : ""}`}>
        {r.count}
      </span>
    </div>
  );
});

// ---------------------------------------------------------------- the browser

/** the launch restore runs once per window (StrictMode mounts twice in dev) */
let restoredOnce = false;

export function Browser() {
  const b = useStore((s) => s.browser);
  const setBrowser = useStore((s) => s.setBrowser);
  const current = useStore((s) => s.slide.path);
  const slideLoading = useStore((s) => s.slide.loading);
  const slideError = useStore((s) => s.slide.error);
  const thumbSize = useSettings((s) => s.s.browser.thumbSize);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const watch = useVisibilityWatcher(listRef);
  const [cursor, setCursor] = useState<string | null>(null);
  /** show the keyboard cursor ring only while the list is driven from the keyboard */
  const [kbd, setKbd] = useState(false);
  const scrollPending = useRef(false);

  useMenuEvent("open_folder", () => void openFolder());
  useMenuEvent("rescan_folder", () => {
    clearThumbFailures();
    void rescan();
  });

  // reopen the last folder (and slide) at launch
  useEffect(() => {
    const s = useSettings.getState().s.browser;
    if (restoredOnce || !hasTauri || useStore.getState().browser.root || !s.reopenLastFolder || !s.lastFolder) return;
    restoredOnce = true;
    void openFolder(s.lastFolder, { restoring: true }).then(() => {
      const st = useStore.getState();
      const last = useSettings.getState().s.browser.lastSlide;
      if (!useSettings.getState().s.browser.reopenLastSlide || !last || st.slide.path) return;
      const e = st.browser.scan?.entries.find((x) => x.path === last);
      if (e) openEntry(e);
    });
  }, []);

  // remember the open slide; keep the badge in step with saves
  useEffect(() => {
    let lastPath: string | null = null;
    return useStore.subscribe((s, prev) => {
      if (s.slide.info && s.slide.path && s.slide.path !== lastPath) {
        lastPath = s.slide.path;
        useSettings.getState().setSection("browser", { lastSlide: s.slide.path });
      }
      const a = s.annotations;
      if (a.save === "saved" && prev.annotations.save !== "saved" && s.slide.path) noteAnnotationsSaved(s.slide.path, a.filePath, a.items.length);
    });
  }, []);

  const entries = useMemo(() => b.scan?.entries ?? [], [b.scan]);
  const rows = useMemo(() => buildRows(entries, b.collapsedDirs, b.query), [entries, b.collapsedDirs, b.query]);
  const totals = useMemo(() => summarize(entries), [entries]);
  const matches = useMemo(() => (b.query.trim() ? rows.filter((r) => r.kind === "slide").length : entries.length), [rows, b.query, entries.length]);

  // the cursor follows the open slide
  useEffect(() => {
    if (current) setCursor(slideKey(current));
  }, [current]);
  // bring the cursor row into view when the cursor moves (its folder may expand a render later)
  useLayoutEffect(() => {
    scrollPending.current = true;
  }, [cursor]);
  useLayoutEffect(() => {
    if (!cursor || !scrollPending.current) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(cursor)}"]`);
    if (!el) return;
    scrollPending.current = false;
    el.scrollIntoView?.({ block: "nearest" });
  }, [cursor, rows]);

  const pick = useCallback((r: Row) => {
    setCursor(r.key);
    if (r.kind === "dir") toggleDir(r.dir);
    else openEntry(r.entry);
  }, []);

  const menu = useCallback(
    (r: Row, ev: MouseEvent) => {
      ev.preventDefault();
      setCursor(r.key);
      const setUi = useStore.getState().setUi;
      if (r.kind === "slide") {
        const e = r.entry;
        setUi({
          menu: {
            x: ev.clientX,
            y: ev.clientY,
            items: [
              { label: "Open", onSelect: () => openEntry(e) },
              "sep",
              { label: revealLabel, onSelect: () => void revealFile(e.path) },
              { label: "Copy Path", onSelect: () => void navigator.clipboard?.writeText(e.path) },
              ...(e.annotationPath ? [{ label: `Show Annotation File`, onSelect: () => void revealFile(e.annotationPath!) }] : []),
            ],
          },
        });
      } else {
        const sub = allDirs(entries).filter((d) => d === r.dir || d.startsWith(`${r.dir}/`));
        const cur = useStore.getState().browser.collapsedDirs;
        setUi({
          menu: {
            x: ev.clientX,
            y: ev.clientY,
            items: [
              { label: r.open ? "Collapse" : "Expand", onSelect: () => toggleDir(r.dir) },
              { label: "Expand All Inside", onSelect: () => setCollapsed(cur.filter((d) => !sub.includes(d))) },
              { label: "Collapse All Inside", onSelect: () => setCollapsed([...cur, ...sub]) },
              "sep",
              { label: "Expand Everything", onSelect: () => setCollapsed([]) },
              { label: "Collapse Everything", onSelect: () => setCollapsed(allDirs(entries)) },
              "sep",
              { label: revealLabel, disabled: !b.root, onSelect: () => b.root && void revealFile(`${b.root.replace(/[\\/]+$/, "")}/${r.dir}`) },
            ],
          },
        });
      }
    },
    [entries, b.root],
  );

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!kbd) setKbd(true);
    if (e.metaKey || e.ctrlKey || e.altKey) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      return;
    }
    if (!rows.length) return;
    const i = Math.max(
      0,
      rows.findIndex((r) => r.key === cursor),
    );
    const r = rows[i];
    const go = (j: number) => setCursor(rows[Math.max(0, Math.min(rows.length - 1, j))].key);
    let used = true;
    switch (e.key) {
      case "ArrowDown":
        go(cursor ? i + 1 : 0);
        break;
      case "ArrowUp":
        go(i - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(rows.length - 1);
        break;
      case "PageDown":
        go(i + 10);
        break;
      case "PageUp":
        go(i - 10);
        break;
      case "ArrowRight":
        if (r.kind === "dir" && !r.open) toggleDir(r.dir, true);
        else if (r.kind === "dir") go(i + 1);
        break;
      case "ArrowLeft":
        if (r.kind === "dir" && r.open && !b.query.trim()) toggleDir(r.dir, false);
        else {
          const parent = r.kind === "dir" ? parentDir(r.dir) : r.entry.dir;
          if (parent) setCursor(dirKey(parent));
        }
        break;
      case "Enter":
      case " ":
        pick(r);
        break;
      case "/":
        searchRef.current?.focus();
        break;
      default:
        used = false;
    }
    if (used) e.preventDefault(); // keys.ts then leaves ← → [ ] alone
  };

  const searchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && rows.length) {
      e.preventDefault();
      const first = rows.find((r) => r.kind === "slide") ?? rows[0];
      setCursor(first.key);
      setKbd(true);
      listRef.current?.focus();
    }
  };
  const searchEnter = () => {
    const first = rows.find((r) => r.kind === "slide");
    if (first && first.kind === "slide") {
      setCursor(first.key);
      openEntry(first.entry);
    }
  };

  if (!b.root) return <BrowserEmpty />;

  const progress = b.progress;
  return (
    <div className="br">
      <div className="br-head">
        <button className="br-root" onClick={() => void openFolder()} title={`${b.root}\nClick to choose a different folder`}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path d="M1.5 4.5v8h13v-7h-7l-1.5-1.5h-4.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
          <b>{basename(b.root.replace(/[\\/]+$/, "")) || b.root}</b>
          <svg width="9" height="9" viewBox="0 0 8 8" aria-hidden className="br-chev">
            <path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          className="btn ghost icon br-refresh"
          onClick={() => {
            clearThumbFailures();
            void rescan();
          }}
          disabled={b.scanning}
          title="Rescan the folder (⌘R)"
          aria-label="Rescan"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden className={b.scanning ? "spin" : ""}>
            <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <SearchField
        className="sv-search br-search"
        value={b.query}
        onChange={(q) => setBrowser({ query: q })}
        onEnter={searchEnter}
        onEscape={() => listRef.current?.focus()}
        onKey={searchKey}
        inputRef={searchRef}
        placeholder="Search slides"
        title="Filter by name or folder (↓ to move into the list)"
      />
      {b.scanning && (
        <div className="br-status" role="status">
          <span className="br-spinner" />
          Scanning… {progress ? `${progress.folders} folder${progress.folders === 1 ? "" : "s"} · ${progress.found} slide${progress.found === 1 ? "" : "s"}` : ""}
        </div>
      )}
      {b.error && (
        <div className="br-status warn">
          <span>{b.error}</span>
          <button className="btn ghost" onClick={() => void openFolder()}>
            Choose…
          </button>
        </div>
      )}
      <VisibleCtx.Provider value={watch}>
        <div
          ref={listRef}
          className={`br-list ${kbd ? "kbd-nav" : ""}`}
          role="tree"
          aria-label="Slides"
          tabIndex={0}
          onKeyDown={onListKey}
          onMouseDown={() => kbd && setKbd(false)}
        >
          {rows.map((r) =>
            r.kind === "dir" ? (
              <DirRow key={r.key} row={r} cursor={cursor === r.key} onPick={pick} onMenu={menu} />
            ) : (
              <SlideRow
                key={r.key}
                row={r}
                current={current === r.entry.path}
                cursor={cursor === r.key}
                thumbSize={thumbSize}
                loading={current === r.entry.path && slideLoading}
                failed={current === r.entry.path && !!slideError}
                onPick={pick}
                onMenu={menu}
              />
            ),
          )}
          {b.scan && !rows.length && (
            <div className="br-empty-list muted small">
              {b.query.trim() ? (
                <>No slides match “{b.query.trim()}”.</>
              ) : (
                <>No slides in this folder or its subfolders.</>
              )}
            </div>
          )}
        </div>
      </VisibleCtx.Provider>
      {b.scan && (
        <div className="br-foot muted small">
          <span>
            {b.query.trim() ? `${matches} of ${totals.slides}` : totals.slides} slide{totals.slides === 1 ? "" : "s"}
            {totals.annotated > 0 && ` · ${totals.annotated} annotated`}
          </span>
          {b.scan.errors.length > 0 && (
            <span className="warn" title={b.scan.errors.join("\n")}>
              {b.scan.errors.length} problem{b.scan.errors.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Open a single slide file (not from the browsed folder). */
async function openSingleFile() {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const exts = await supportedExtensions().catch(() => [] as string[]);
    const p = await open({
      multiple: false,
      title: "Open a slide",
      filters: exts.length ? [{ name: "Slides and images", extensions: exts.map((e) => e.replace(/^\./, "")) }] : undefined,
    });
    if (typeof p === "string") void useStore.getState().openSlide(p);
  } catch {
    /* not in the app */
  }
}

function BrowserEmpty() {
  const error = useStore((s) => s.browser.error);
  return (
    <div className="br-empty">
      <svg width="34" height="34" viewBox="0 0 16 16" aria-hidden className="br-empty-ic">
        <path d="M1.5 4.5v8h13v-7h-7l-1.5-1.5h-4.5z" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" />
      </svg>
      <h3>Choose a folder of slides</h3>
      <p className="muted small">
        Slide Viewer looks through the folder and all of its subfolders for slides (.ndpi, .svs, .tif, .mrxs, .czi, images…) and lists them here.
      </p>
      <button className="btn light" onClick={() => void openFolder()}>
        Choose Folder…
      </button>
      {hasTauri && (
        <button className="btn ghost" onClick={() => void openSingleFile()}>
          Open a Single Slide…
        </button>
      )}
      {error && <p className="warn small">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Preferences ▸ Slide browser

export function BrowserPrefs() {
  const s = useSettings((x) => x.s.browser);
  const set = useSettings((x) => x.setSection);
  const sizes: [string, string][] = [
    ["0", "Off"],
    ["48", "Small"],
    ["72", "Medium"],
    ["112", "Large"],
  ];
  const cur = sizes.some(([v]) => Number(v) === s.thumbSize) ? String(s.thumbSize) : "72";
  return (
    <>
      <PrefGroup title="List">
        <PrefRow label="Thumbnails" help="Off shows a compact list of names.">
          <Seg value={cur} options={sizes} onChange={(v) => set("browser", { thumbSize: Number(v) })} />
        </PrefRow>
      </PrefGroup>
      <PrefGroup title="At launch">
        <PrefRow label="Folder">
          <Check checked={s.reopenLastFolder} onChange={(v) => set("browser", { reopenLastFolder: v })}>
            Reopen the last folder
          </Check>
        </PrefRow>
        <PrefRow label="Slide">
          <Check checked={s.reopenLastSlide} onChange={(v) => set("browser", { reopenLastSlide: v })}>
            Reopen the slide I was looking at
          </Check>
        </PrefRow>
        <PrefRow label="Last folder" help={s.lastFolder ? <span className="mono">{s.lastFolder}</span> : "None yet. Choose one with File ▸ Open Folder…"}>
          {s.lastFolder && (
            <button className="btn ghost" onClick={() => set("browser", { lastFolder: null, lastSlide: null })}>
              Forget
            </button>
          )}
        </PrefRow>
        {Object.keys(s.collapsed ?? {}).length > 0 && (
          <PrefRow label="Folders" help="Expanded and collapsed folders are remembered per folder.">
            <button className="btn ghost" onClick={() => set("browser", { collapsed: {} })}>
              Forget Collapsed Folders
            </button>
          </PrefRow>
        )}
      </PrefGroup>
    </>
  );
}
