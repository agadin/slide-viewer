/**
 * App shell: top bar | slide browser (left) | viewer (centre) | panel with Annotations / Adjust tabs (right).
 * SHARED FILE: builders mount their features through their own components (see CONTRACTS.md);
 * append here only if unavoidable, in a clearly delimited block.
 */
import { useEffect, useState } from "react";
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
import { useMenuEvent } from "./lib/menu";
import { useGlobalKeys } from "./lib/keys";
import { useAnnotationFile } from "./lib/autosave";

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

  // flush autosaves before the window goes away
  useEffect(() => {
    const before = () => void useStore.getState().flushAll();
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, []);

  return (
    <div className={`app-shell ${isMac ? "mac-overlay" : ""} ${ui.sidebarOpen ? "" : "no-side"} ${ui.panelOpen ? "" : "no-panel"}`}>
      <header className="sv-top" data-tauri-drag-region>
        <button className={`tbtn ${ui.sidebarOpen ? "on" : ""}`} onClick={() => setUi({ sidebarOpen: !ui.sidebarOpen })} title="Show / hide the slide browser">
          Slides
        </button>
        <div className="sv-title" data-tauri-drag-region>
          <b>{slidePath ? basename(slidePath) : "Slide Viewer"}</b>
          {info && !info.calibrated && <span className="sv-badge warn">uncalibrated</span>}
        </div>
        <div className="grow" data-tauri-drag-region />
        <button className="tbtn" onClick={() => void showHelp("index")} title="Help">
          ?
        </button>
        <button className="tbtn" onClick={() => setUi({ settingsOpen: true })} title="Preferences (⌘,)" aria-label="Preferences">
          <IconSliders />
        </button>
        <button className={`tbtn ${ui.panelOpen ? "on" : ""}`} onClick={() => setUi({ panelOpen: !ui.panelOpen })} title="Show / hide the side panel">
          Panel
        </button>
      </header>

      <aside className="sv-side">
        <Browser />
      </aside>

      <main className="sv-main">
        <SlideViewer />
        <Toolbar />
      </main>

      <aside className="sv-panel">
        <div className="seg sv-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={ui.panelTab === t.id} className={ui.panelTab === t.id ? "on" : ""} onClick={() => setUi({ panelTab: t.id })}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="sv-panel-body">{ui.panelTab === "annotations" ? <AnnotationPanel /> : <AdjustPanel />}</div>
      </aside>

      <UpdateBanner />
      {ui.help !== null && <HelpPanel />}
      {ui.menu && <ContextMenu menu={ui.menu} />}
      {ui.toast && <div className={`sv-toast ${ui.toast.kind}`} role="status">{ui.toast.text}</div>}
      {ui.settingsOpen && prefsFallback && <SettingsDialog onClose={() => setUi({ settingsOpen: false })} />}
    </div>
  );
}
