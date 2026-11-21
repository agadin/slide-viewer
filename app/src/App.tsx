/**
 * App shell: top bar | slide browser (left) | viewer (centre) | panel with Annotations / Adjust tabs (right).
 * SHARED FILE: builders mount their features through their own components (see CONTRACTS.md);
 * append here only if unavoidable, in a clearly delimited block.
 */
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { UpdateBanner } from "./components/UpdateBanner";
import { HelpPanel } from "./components/HelpPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { ContextMenu } from "./components/ContextMenu";
import { SlideViewer } from "./components/SlideViewer";
import { Toolbar } from "./components/Toolbar";
import { Browser } from "./components/Browser";
import { AnnotationPanel } from "./components/AnnotationPanel";
import { AdjustPanel } from "./components/AdjustPanel";
import { IconSliders } from "./components/icons";
import { basename, isMac, openPreferencesWindow, showHelp } from "./lib/backend";
import { useStore, type PanelTab } from "./lib/store";
import { useSettings } from "./lib/settings";
import { useMenuEvent } from "./lib/menu";
import { useGlobalKeys } from "./lib/keys";
import { useAnnotationFile } from "./lib/autosave";
import { useAnnouncements } from "./lib/announce"; // a11y(semantics)

const TABS: { id: PanelTab; label: string }[] = [
  { id: "annotations", label: "Annotations" },
  { id: "adjust", label: "Adjust" },
];

export default function App() {
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const slidePath = useStore((s) => s.slide.path);
  const info = useStore((s) => s.slide.info);

  useGlobalKeys();
  useAnnotationFile();
  useAnnouncements(); // a11y(semantics): live regions, status announcements, document title
  useMenuEvent("toggle_browser", () => setUi({ sidebarOpen: !useStore.getState().ui.sidebarOpen }));
  useMenuEvent("toggle_panel", () => setUi({ panelOpen: !useStore.getState().ui.panelOpen }));

  // Preferences open in their own window; outside Tauri fall back to a modal
  const [prefsFallback, setPrefsFallback] = useState(false);
  useEffect(() => {
    if (!ui.settingsOpen) return;
    openPreferencesWindow()
      .then(() => setUi({ settingsOpen: false }))
      .catch(() => setPrefsFallback(true));
  }, [ui.settingsOpen, setUi]);

  // toasts fade on their own
  useEffect(() => {
    if (!ui.toast) return;
    const t = setTimeout(() => setUi({ toast: null }), 4000);
    return () => clearTimeout(t);
  }, [ui.toast, setUi]);

  // Preferences ▸ Viewing ▸ open full screen (read once at launch)
  useEffect(() => {
    if (!useSettings.getState().s.viewer.openFullScreen) return;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setFullscreen(true))
      .catch(() => {
        /* not in the app */
      });
  }, []);

  // flush autosaves before the window goes away
  useEffect(() => {
    const before = () => void useStore.getState().flushAll();
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, []);

  return (
    <div className={`app-shell ${isMac ? "mac-overlay" : ""} ${ui.sidebarOpen ? "" : "no-side"} ${ui.panelOpen ? "" : "no-panel"}`}>
      <header className="sv-top" data-tauri-drag-region>
        <button
          className={`tbtn ${ui.sidebarOpen ? "on" : ""}`}
          onClick={() => setUi({ sidebarOpen: !ui.sidebarOpen })}
          title="Show / hide the slide browser"
          aria-pressed={ui.sidebarOpen}
          aria-controls="sv-side"
        >
          Slides
        </button>
        <div className="sv-title" data-tauri-drag-region>
          <h1 className="sv-h1" data-tauri-drag-region>
            <b>{slidePath ? basename(slidePath) : "Slide Viewer"}</b>
          </h1>
          {info && !info.calibrated && <span className="sv-badge warn">uncalibrated</span>}
        </div>
        <div className="grow" data-tauri-drag-region />
        <button className="tbtn" onClick={() => void showHelp("index")} title="Help" aria-label="Help">
          ?
        </button>
        <button className="tbtn" onClick={() => setUi({ settingsOpen: true })} title="Preferences (⌘,)" aria-label="Preferences">
          <IconSliders />
        </button>
        <button
          className={`tbtn ${ui.panelOpen ? "on" : ""}`}
          onClick={() => setUi({ panelOpen: !ui.panelOpen })}
          title="Show / hide the image panel (annotations and adjustments)"
          aria-pressed={ui.panelOpen}
          aria-controls="sv-panel"
        >
          Image
        </button>
      </header>

      <nav className="sv-side" id="sv-side" aria-label="Slide browser">
        <Browser />
      </nav>

      <main className="sv-main" aria-label="Slide">
        <SlideViewer />
        <Toolbar />
      </main>

      <aside className="sv-panel" id="sv-panel" aria-label="Image panel">
        <PanelTabs tab={ui.panelTab} onTab={(t) => setUi({ panelTab: t })} />
        <div className="sv-panel-body" role="tabpanel" id={`sv-tabpanel-${ui.panelTab}`} aria-labelledby={`sv-tab-${ui.panelTab}`}>
          {ui.panelTab === "annotations" ? <AnnotationPanel /> : <AdjustPanel />}
        </div>
      </aside>

      <UpdateBanner />
      {ui.help !== null && <HelpPanel />}
      {ui.menu && <ContextMenu menu={ui.menu} />}
      {ui.toast && <div className={`sv-toast ${ui.toast.kind}`} role="status">{ui.toast.text}</div>}
      {ui.settingsOpen && prefsFallback && <SettingsDialog onClose={() => setUi({ settingsOpen: false })} />}
    </div>
  );
}

/** a11y(semantics): the right panel's tabs, an ARIA tablist (← → Home End move between tabs; roving tabindex) */
function PanelTabs({ tab, onTab }: { tab: PanelTab; onTab: (t: PanelTab) => void }) {
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (j === null) return;
    e.preventDefault();
    e.stopPropagation(); // keys.ts would step slides on ← →
    const next = TABS[(j + TABS.length) % TABS.length].id;
    onTab(next);
    requestAnimationFrame(() => document.getElementById(`sv-tab-${next}`)?.focus());
  };
  return (
    <div className="seg sv-tabs" role="tablist" aria-label="Image panel" onKeyDown={onKey}>
      {TABS.map((t) => (
        <button
          key={t.id}
          id={`sv-tab-${t.id}`}
          role="tab"
          aria-selected={tab === t.id}
          aria-controls={`sv-tabpanel-${t.id}`}
          tabIndex={tab === t.id ? 0 : -1}
          className={tab === t.id ? "on" : ""}
          onClick={() => onTab(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
