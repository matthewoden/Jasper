import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { SetupApp } from "./setup/SetupApp";
import { loadDraft } from "./setup/draft";
import "./theme.css";

// ── First-paint theme bootstrap for the wizard ────────────────────────
// On `/setup`, the steady-state useTheme hook is not in scope (it depends
// on GET /api/v1/config, a post-setup endpoint). Reading the persisted
// draft synchronously here sets <html data-theme> before React mounts so
// the wizard doesn't flash dark→light when the user previously picked
// light on a half-completed run.
//
// On every other route, the existing useTheme hook / theme bootstrap
// script already owns this attribute — we leave it alone.
const path = window.location.pathname;
if (path === "/setup") {
  try {
    const { theme } = loadDraft();
    document.documentElement.setAttribute("data-theme", theme);
  } catch {
    /* private mode — fall through, useTheme will fix it post-setup */
  }
}

// ── Route dispatch ─────────────────────────────────────────────────────
// Plain path-based dispatch — the project does not use React Router
// (a single-binary SPA with a tiny route surface doesn't justify it).
// Plan 08-07 extends this with an `else if (path === "/note-not-found")`
// branch; the explicit early-return shape below is the agreed extension
// point so 08-07's edit is purely additive (no merge conflict).
const root = ReactDOM.createRoot(document.getElementById("root")!);
if (path === "/setup") {
  root.render(
    <React.StrictMode>
      <SetupApp />
    </React.StrictMode>,
  );
} else {
  // Plan 08-07 inserts `/note-not-found` branch here as an additional `else if`.
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
