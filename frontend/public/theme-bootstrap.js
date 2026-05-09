// frontend/public/theme-bootstrap.js
//
// Phase 5 / Plan 05-10 — first-paint theme bootstrap.
// Runs SYNCHRONOUSLY before React mounts; sets <html data-theme>
// from localStorage["jasper:theme-bootstrap"] (persisted preference)
// OR prefers-color-scheme (D-15 first-run default).
//
// Why a static file and not an inline <script>:
//   Plan 05-04's CSP `script-src 'self'` BLOCKS inline scripts. A
//   same-origin static file satisfies 'self' so the browser permits
//   it during HTML parse — and it executes synchronously, before
//   React mounts, eliminating the dark-flash (RESEARCH §Pitfall 8).
(function () {
  try {
    var pref = localStorage.getItem("jasper:theme-bootstrap");
    if (pref === "dark" || pref === "light") {
      document.documentElement.setAttribute("data-theme", pref);
      return;
    }
  } catch (e) {
    /* localStorage disabled (private mode) — fall through to media query */
  }
  var dark =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
})();
