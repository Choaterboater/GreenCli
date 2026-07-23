import React from "react";
import ReactDOM from "react-dom/client";
import { appWindow } from "@tauri-apps/api/window";
import App from "./App";
import PopOutTerminal from "./PopOutTerminal";
import "./styles/index.css";

// Pop-out session windows (label `popout-<sessionId>`) load the same bundle
// but render a terminal-only view instead of the full app shell.
const isPopOut = appWindow.label.startsWith("popout-");

// Prevent default browser reload on Cmd+R / Ctrl+R / F5 / Cmd+Shift+R
document.addEventListener("keydown", (e) => {
  if (
    ((e.key === "r" || e.key === "R") && (e.metaKey || e.ctrlKey)) ||
    e.key === "F5"
  ) {
    e.preventDefault();
  }
});

// Prevent the WebView's native context menu from exposing Reload. Keep Monaco's
// editor menu working because users rely on it for editor actions, and keep the
// native menu on text fields so right-click Copy/Paste works there (the field
// menus don't carry Reload). The terminal renders its own context menu
// (Terminal.tsx) — its hidden xterm textarea is excluded here so the native
// field menu can't shadow it.
document.addEventListener("contextmenu", (e) => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) {
    e.preventDefault();
    return;
  }
  if (target.closest(".monaco-editor")) return;
  if (target.closest(".xterm")) return; // Terminal.tsx handles + prevents
  if (target.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isPopOut ? <PopOutTerminal /> : <App />}
  </React.StrictMode>
);
