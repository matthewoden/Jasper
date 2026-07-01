import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { NoteNotFoundView } from "./components/NoteNotFoundView";
import { ToastProvider } from "./components/Toast";
import { SetupApp } from "./setup/SetupApp";
import "./theme.css";


const path = window.location.pathname;
if (path === "/setup") {
  // Dark-only (D-01): the wizard has no theme toggle, so pin dark for the setup page.
  document.documentElement.setAttribute("data-theme", "dark");
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
