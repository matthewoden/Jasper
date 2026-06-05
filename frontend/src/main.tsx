import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { NoteNotFoundView } from "./components/NoteNotFoundView";
import { ToastProvider } from "./components/Toast";
import { SetupApp } from "./setup/SetupApp";
import { loadDraft } from "./setup/draft";
import "./theme.css";


const path = window.location.pathname;
if (path === "/setup") {
  try {
    const { theme } = loadDraft();
    document.documentElement.setAttribute("data-theme", theme);
  } catch {
    /* private mode — fall through, useTheme will fix it post-setup */
  }
}


const root = ReactDOM.createRoot(document.getElementById("root")!);
if (path === "/setup") {
  root.render(
    <React.StrictMode>
      <SetupApp />
    </React.StrictMode>,
  );
} else if (path === "/note-not-found") {
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
