/**
 * Preferences: its own window (index.html?window=preferences), or a modal outside Tauri.
 * SHARED FILE. Each pane's body lives in its feature's own file (ViewerPrefs, AnnotationPrefs,
 * AdjustPrefs, BrowserPrefs); builders edit those, not this file. Settings: lib/settings.ts.
 */
import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettings } from "../lib/settings";
import { hitRef, searchHelp } from "../lib/help";
import { showHelp } from "../lib/backend";
import { IconInfo, IconPin, IconSliders, IconTarget, IconKeyboard, IconPerson } from "./icons";
import { AboutPane } from "./AboutPane";
import { Modal } from "./Modal";
import { SearchField } from "./controls";
import { ViewerPrefs } from "./viewer/ViewerPrefs";
import { AnnotationPrefs } from "./annotations/AnnotationPrefs";
import { AdjustPrefs } from "./AdjustPanel";
import { BrowserPrefs } from "./Browser";
import { AccessibilityPrefs } from "./AccessibilityPrefs"; // a11y(visual)

type Pane = "viewer" | "annotations" | "adjust" | "browser" | "a11y" | "about";
const PANES: { id: Pane; label: string; icon: ReactNode; lede: string; body: () => ReactNode }[] = [
  { id: "viewer", label: "Viewing", icon: <IconKeyboard />, lede: "Zooming, panning and what shows over the slide.", body: () => <ViewerPrefs /> },
  { id: "annotations", label: "Pins & shapes", icon: <IconPin />, lede: "How new pins and shapes look, and saving.", body: () => <AnnotationPrefs /> },
  { id: "adjust", label: "Adjustments", icon: <IconSliders />, lede: "Image adjustments and automatic stain handling.", body: () => <AdjustPrefs /> },
  { id: "browser", label: "Slide browser", icon: <IconTarget />, lede: "The folder of slides and how it's listed.", body: () => <BrowserPrefs /> },
  // a11y(visual)
  { id: "a11y", label: "Accessibility", icon: <IconPerson />, lede: "Text size, contrast, motion, and how pins and shapes are drawn.", body: () => <AccessibilityPrefs /> },
  { id: "about", label: "About", icon: <IconInfo />, lede: "Version, help and updates.", body: () => <AboutPane /> },
];

/** Preferences rendered as its own window (index.html?window=preferences). */
export function PreferencesWindow() {
  return (
    <SettingsDialog
      asWindow
      onClose={() => {
        getCurrentWindow()
          .close()
          .catch(() => window.close());
      }}
    />
  );
}

export function SettingsDialog({ onClose, asWindow = false }: { onClose: () => void; asWindow?: boolean }) {
  const reset = useSettings((s) => s.reset);
  const [pane, setPane] = useState<Pane>("viewer");
  const [q, setQ] = useState("");
  const meta = PANES.find((p) => p.id === pane)!;
  const helpHits = q.trim() ? searchHelp(q, 8) : [];

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement)?.closest?.(".prefs-search") && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const body = (
    <div className="prefs">
      <nav className="prefs-nav" aria-label="Preference panes">
        <SearchField className="prefs-search" ariaLabel="Search preferences and help" onEscape={onClose} value={q} onChange={setQ} onEnter={() => helpHits[0] && void showHelp(hitRef(helpHits[0]))} />
        {q.trim() ? (
          <div className="prefs-results">
            {helpHits.length > 0 && <div className="pr-h">Help</div>}
            {helpHits.map((h, i) => (
              <button key={i} onClick={() => void showHelp(hitRef(h))}>
                <span>{h.anchor ? h.label : h.title}</span>
                <span className="pr-where">{h.anchor ? h.title : "Help"} ↗</span>
              </button>
            ))}
            {!helpHits.length && <p className="pr-none">Nothing matches “{q}”.</p>}
          </div>
        ) : (
          PANES.map((p) => (
            <button key={p.id} className={pane === p.id ? "on" : ""} aria-current={pane === p.id ? "page" : undefined} onClick={() => setPane(p.id)}>
              {p.icon}
              {p.label}
            </button>
          ))
        )}
        <div className="grow" />
        <button className="btn ghost small" onClick={() => confirm("Reset every preference to its default?") && reset()}>
          Reset all
        </button>
      </nav>
      <div className="prefs-content" role="region" aria-labelledby="prefs-pane-title">
        <div className="prefs-h">
          <h2 id="prefs-pane-title">{meta.label}</h2>
        </div>
        <p className="lede">{meta.lede}</p>
        {meta.body()}
      </div>
    </div>
  );

  if (asWindow) return <div className="prefs-window">{body}</div>;
  return (
    // Esc is handled above
    <Modal className="prefs-modal" onClose={onClose} escape={false}>
      <div className="win-title">Preferences</div>
      {body}
    </Modal>
  );
}
