// Package firstrun implements the Phase 8 first-run wizard server gate
// (INSTALL-07, D-04, D-07, D-08, D-10).
//
// Two responsibilities live here:
//
//   - RedirectMiddleware (this file): a chi middleware that 302-redirects
//     every non-/setup, non-/api/v1/setup/*, non-/assets/* request to
//     /setup whenever <dataDir>/storage/config.json does NOT yet exist.
//     This is the single source of truth for "is this a first-run boot?" —
//     the SPA never has to branch on first-run-vs-steady-state because the
//     redirect happens before any non-wizard route is reached.
//
//   - ValidateDataDir + RunSetup (validate.go + submit.go): the wizard's
//     server-side validate-data-dir and submit pipelines. They live in
//     this package (rather than internal/api) so the http handler layer
//     stays a thin adapter and the side-effecting work (mkdir + config
//     write + migration runner + optional daily-note seed) is testable
//     without spinning up a full chi router.
package firstrun

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// RedirectMiddleware returns a chi middleware that 302-redirects every
// request to /setup when <dataDir>/storage/config.json is absent.
//
// Pass-through rules (must run before the existence check):
//   - exact path /setup (the wizard SPA mount point)
//   - any path with /api/v1/setup prefix (validate-data-dir, status, submit)
//   - any path with /assets prefix (the wizard's JS/CSS bundles served
//     from the embedded //go:embed dist/)
//
// Once config.json exists, the middleware is a no-op for every request.
//
// The cfgPath is resolved once at construction so the per-request hot
// path is a single os.Stat call. dataDir is passed by value; if the
// caller's config.Server.DataDir changes after the middleware is
// constructed (it does not in the current architecture; data-dir is
// fixed at boot), the middleware will keep checking the original path.
func RedirectMiddleware(dataDir string) func(http.Handler) http.Handler {
	cfgPath := filepath.Join(dataDir, "storage", "config.json")
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Pass-through rules. Order: exact match first (fast), then
			// the prefix checks. The /assets prefix catches both Vite's
			// hashed bundle filenames (/assets/index-DEADBEEF.js) and
			// the wizard SPA's static bundle once 08-04 lands.
			if r.URL.Path == "/setup" ||
				strings.HasPrefix(r.URL.Path, "/api/v1/setup") ||
				strings.HasPrefix(r.URL.Path, "/assets") {
				next.ServeHTTP(w, r)
				return
			}
			// Existence check. Using errors.Is(err, fs.ErrNotExist) (NOT
			// os.IsNotExist) so the check works through any wrapping a
			// future filesystem abstraction might add. A non-not-exist
			// error from os.Stat (permission denied, I/O error) falls
			// through to next.ServeHTTP — the request continues and the
			// downstream code path (config.Load) surfaces the underlying
			// problem with a proper error, not a misleading redirect.
			if _, err := os.Stat(cfgPath); errors.Is(err, fs.ErrNotExist) {
				http.Redirect(w, r, "/setup", http.StatusFound)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
