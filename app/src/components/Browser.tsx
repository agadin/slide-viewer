/**
 * TODO(browser builder): left sidebar slide browser: folder picker, collapsible tree mirroring
 * subfolders, a thumbnail per slide (backend.slideThumbnail), name search, annotation badge,
 * current-slide highlight, last folder remembered. Menu "open_folder" / "rescan_folder".
 * Also BrowserPrefs (Preferences ▸ Slide browser: settings.browser).
 * Owner: browser (CONTRACTS.md). Currently a stub with a plain list so the viewer can be used.
 */
import { basename, hasTauri } from "../lib/backend";
import { openFolder, rescan } from "../lib/browser";
import { useMenuEvent } from "../lib/menu";
import { useStore } from "../lib/store";

export function Browser() {
  const b = useStore((s) => s.browser);
  const current = useStore((s) => s.slide.path);
  const openSlide = useStore((s) => s.openSlide);
  useMenuEvent("open_folder", () => void openFolder());
  useMenuEvent("rescan_folder", () => void rescan());

  const openFile = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const p = await open({ multiple: false, title: "Open a slide" });
      if (typeof p === "string") void openSlide(p);
    } catch {
      /* not in the app */
    }
  };

  return (
    <div className="stub browser-stub">
      <div className="row">
        <button className="btn" onClick={() => void openFolder()}>
          Open Folder…
        </button>
        {hasTauri && (
          <button className="btn ghost" onClick={openFile} title="Open a single slide file">
            File…
          </button>
        )}
      </div>
      {b.root && <p className="muted small mono">{b.root}</p>}
      {b.scanning && <p className="muted small">Scanning…</p>}
      {b.error && <p className="warn small">{b.error}</p>}
      <ul className="stub-list">
        {b.scan?.entries.map((e) => (
          <li key={e.path} className={e.path === current ? "on" : ""} onClick={() => void openSlide(e.path)}>
            {e.dir ? `${e.dir}/` : ""}
            {basename(e.path)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BrowserPrefs() {
  return <p className="stub muted">Slide browser preferences are coming.</p>;
}
