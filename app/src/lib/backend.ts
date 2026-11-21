/**
 * Typed wrappers for every Tauri command (src-tauri/src/lib.rs). SHARED, effectively frozen:
 * every command is already here; builders call these rather than `invoke` directly.
 */
import { invoke } from "@tauri-apps/api/core";
import type { AnnotationPaths, ScanResult, SlideInfo, ZPlane } from "./types";

/** image encodings the region/associated/overview commands return */
export type ImgFormat = "jpeg" | "png" | "rgba";
const bytes = async (p: Promise<ArrayBuffer>) => new Uint8Array(await p);

// ---- slides (formats)
/** `series`: which image of a multi-image file (SlideInfo.series); 0 = the default one */
export const openSlide = (path: string, series = 0) => invoke<SlideInfo>("open_slide", { path, series });
export const closeSlide = (id: number) => invoke<boolean>("close_slide", { id });
export const slideInfo = (id: number) => invoke<SlideInfo | null>("slide_info", { id });
export const slideZPlanes = (id: number) => invoke<ZPlane[]>("slide_z_planes", { id });
/** lower-case with the dot: [".bif", ".czi", ".dcm", ".jpeg", …] */
export const supportedExtensions = () => invoke<string[]>("supported_extensions");
export const slideAssociated = (id: number, name: string, maxPx?: number, format: ImgFormat = "jpeg") =>
  bytes(invoke<ArrayBuffer>("slide_associated", { id, name, maxPx, format }));
/** level-0 rect scaled to outWidth × outHeight. "rgba" gives raw bytes for `new ImageData`. */
export const slideRegion = (
  id: number,
  r: { x: number; y: number; width: number; height: number; outWidth: number; outHeight: number; z?: number },
  format: ImgFormat = "jpeg",
) =>
  bytes(
    invoke<ArrayBuffer>("slide_region", {
      id,
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
      outWidth: Math.round(r.outWidth),
      outHeight: Math.round(r.outHeight),
      z: r.z ?? 0,
      format,
    }),
  );
/** the whole slide fitted into maxPx (size = fitSize(info.width, info.height, maxPx)) */
export const slideOverview = (id: number, maxPx: number, z = 0, format: ImgFormat = "rgba") =>
  bytes(invoke<ArrayBuffer>("slide_overview", { id, maxPx, z, format }));
/** the size slide_overview / the Rust `fit` produce */
export const fitSize = (w: number, h: number, maxPx: number) => {
  const s = Math.min(1, maxPx / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
};

// ---- folder browser (browser)
/** listen to "scan-progress" (ScanProgress) for progress */
export const scanFolder = (dir: string) => invoke<ScanResult>("scan_folder", { dir });
/** JPEG bytes */
export const slideThumbnail = (path: string, maxPx = 256) => bytes(invoke<ArrayBuffer>("slide_thumbnail", { path, maxPx }));

// ---- annotation files (annotations)
export const annotationPaths = (slidePath: string) => invoke<AnnotationPaths>("annotation_paths", { slidePath });

// ---- generic files
export const listFiles = (dir: string, suffixes: string[] = []) => invoke<string[]>("list_files", { dir, suffixes });
/** maxBytes: reject files larger than this */
export const readText = (path: string, maxBytes?: number) => invoke<string>("read_text", { path, maxBytes });
export const readBytes = (path: string) => bytes(invoke<ArrayBuffer>("read_bytes", { path }));
/** atomic (temp + rename); keepBackup leaves the previous version as <file>.bak */
export const writeText = (path: string, contents: string, keepBackup = false) =>
  invoke<void>("write_text", { path, contents, keepBackup });
const rawWrite = (cmd: string, path: string, data: Uint8Array) =>
  invoke<void>(cmd, data, { headers: { path: encodeURIComponent(path) } });
export const writeBytes = (path: string, data: Uint8Array) => rawWrite("write_bytes", path, data);
/** data must be a PNG (e.g. from canvas.toBlob) */
export const savePng = (path: string, data: Uint8Array) => rawWrite("save_png", path, data);
export const pathExists = (path: string) => invoke<boolean>("path_exists", { path });

// ---- windows
/** opens/focuses the separate Preferences window; rejects outside Tauri */
export const openPreferencesWindow = () => invoke<void>("open_preferences");
/** Open a help article ("article" or "article/section") in the Help window; in a plain browser, the in-page panel. */
export const showHelp = async (ref: string) => {
  try {
    await invoke<void>("open_help", { topic: ref });
  } catch {
    const { useStore } = await import("./store");
    useStore.getState().setUi({ help: ref });
  }
};
/** Open a web link in the user's browser. */
export const openExternal = async (url: string) => {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
};

/** Show a file or folder in Finder / Explorer. */
export const revealFile = async (p: string) => {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(p);
  } catch {
    /* not in the app */
  }
};

/** Folder picker (Tauri dialog); null when cancelled or outside the app. */
export const pickFolder = async (title = "Choose a folder of slides"): Promise<string | null> => {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ directory: true, multiple: false, title });
    return typeof r === "string" ? r : null;
  } catch {
    return null;
  }
};

/** Save dialog; null when cancelled. */
export const pickSavePath = async (defaultPath: string, filters: { name: string; extensions: string[] }[]) => {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    return (await save({ defaultPath, filters })) ?? null;
  } catch {
    return null;
  }
};

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
export const isMac = ua.includes("Mac");
const isWindows = ua.includes("Windows");
/** running inside the app's window */
export const hasTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** running in the real app, not a test stand-in */
export const inRealApp = () => hasTauri && !(window as { __SV_TEST__?: boolean }).__SV_TEST__;
/** Base URL of the custom `slide://` tile protocol (differs on Windows/WebView2). */
export const tileBase: string =
  (typeof window !== "undefined" && (window as unknown as { __SV_TILE_BASE__?: string }).__SV_TILE_BASE__) ||
  (isWindows ? "http://slide.localhost" : "slide://localhost");
/** Tile URL (CONTRACTS.md "Tile scheme"). */
export const tileUrl = (id: number, level: number, x: number, y: number, z = 0) =>
  z ? `${tileBase}/${id}/${z}/${level}/${x}_${y}.jpg` : `${tileBase}/${id}/${level}/${x}_${y}.jpg`;

export const sep = isWindows ? "\\" : "/";
export const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const dirname = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i <= 0 ? p : p.slice(0, i);
};
/** add the extension if a save dialog's path doesn't already end with it: withExt("a", "ndpa") → "a.ndpa" */
export const withExt = (p: string, ext: string) => (p.toLowerCase().endsWith(`.${ext}`) ? p : `${p}.${ext}`);
export const joinPath = (...parts: string[]) =>
  parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, ""))).join(sep);
