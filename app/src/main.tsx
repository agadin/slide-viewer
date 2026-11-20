import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { PreferencesWindow } from "./components/SettingsDialog";
import { HelpWindow } from "./components/HelpPanel";

const which = new URLSearchParams(location.search).get("window");
// dev-only end-to-end smoke run (tools/smoke.sh); stripped from production builds
if (import.meta.env.DEV && !which && new URLSearchParams(location.search).has("smoke")) void import("./dev/smoke");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{which === "preferences" ? <PreferencesWindow /> : which === "help" ? <HelpWindow /> : <App />}</React.StrictMode>,
);
