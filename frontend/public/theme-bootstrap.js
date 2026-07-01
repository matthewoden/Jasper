// frontend/public/theme-bootstrap.js
//
// Phase 17: Dark-only; accent + reading-font bootstrap added.
// Runs synchronously before React mounts. CSP 'self' allows this static file.
//
// Each concern is in its own try/catch so a private-mode localStorage throw
// on one section does not skip the others (Pitfall 2 fix: no early return).
(function () {
  // Dark only (D-01) — no media query branch.
  document.documentElement.setAttribute("data-theme", "dark");

  // Accent bootstrap — prevent first-paint flash of wrong accent (D-07).
  try {
    var acc = localStorage.getItem("jasper:accent-bootstrap") || "purple";
    var accMap = { purple: "#a78bfa", sky: "#7dd3fc", green: "#34d399", orange: "#fb923c" };
    document.documentElement.style.setProperty("--color-accent", accMap[acc] || "#a78bfa");
  } catch (e) {
    /* localStorage disabled (private mode) — CSS var falls back to :root default */
  }

  // Reading-font bootstrap — prevent first-paint layout shift (D-03).
  try {
    if (localStorage.getItem("jasper:reading-font-bootstrap") === "serif") {
      document.documentElement.style.setProperty(
        "--font-reading",
        "'Source Serif 4', Georgia, serif"
      );
    }
  } catch (e) {
    /* localStorage disabled (private mode) — falls back to :root --font-reading */
  }
})();
