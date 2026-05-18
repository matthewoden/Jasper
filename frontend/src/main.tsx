import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { NoteNotFoundView } from "./components/NoteNotFoundView";
import { ToastProvider } from "./components/Toast";
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
} else if (path === "/note-not-found") {
  // Plan 08-07 (D-32 / SHARE-02): deep-link miss view. The page-title
  // string is LOCKED per UI-SPEC §Copywriting line 222.
  //
  // Plan 08-15 fix (Rule 1): NoteNotFoundView transitively uses
  // useDailyNote → useToast which requires a ToastProvider in the React
  // tree. Without the provider, the component throws "useToast must be
  // used inside <ToastProvider>" at mount and the entire view fails to
  // render (blank page). Wrap in ToastProvider here — same pattern as
  // App.tsx which mounts ToastProvider at its root.
  document.title = "Note not found — Jasper";
  root.render(
    <React.StrictMode>
      <ToastProvider>
        <NoteNotFoundView />
      </ToastProvider>
    </React.StrictMode>,
  );
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
