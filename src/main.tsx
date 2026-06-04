import React from "react";
import ReactDOM from "react-dom/client";
import { appWindow } from "@tauri-apps/api/window";
import App from "./App";
import PopOutTerminal from "./PopOutTerminal";
import "./styles/index.css";

// Pop-out session windows (label `popout-<sessionId>`) load the same bundle
// but render a terminal-only view instead of the full app shell.
const isPopOut = appWindow.label.startsWith("popout-");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isPopOut ? <PopOutTerminal /> : <App />}
  </React.StrictMode>
);
