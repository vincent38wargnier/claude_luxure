import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import vscode from "./vscode";
import { startMemWatch } from "./memwatch";

// Liveness + heap watchdog live OUTSIDE React so they keep working even if the
// component tree crashes — the host recreates the webview when pongs stop.
window.addEventListener("message", (event) => {
  const msg = event.data as { type?: string; t?: number } | undefined;
  if (msg?.type === "ping") {
    vscode.postMessage({ type: "pong", t: msg.t });
  }
});
startMemWatch();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
