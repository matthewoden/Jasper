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
// Deprecated: as of Plan 08-17b (vault model), the no-vault state is
// handled by the lifecycle's vaultMode branch — not by a redirect
// middleware. The /setup route is repurposed as a legacy alias for
// /vault/create. This function is retained for one minor version to
// ease testing rollback; it is NOT mounted on the live router.
//
// Pass-through rules (must run before the existence check):
//   - exact path /setup (the wizard SPA mount point)
//   - any path with /api/v1/setup prefix (validate-data-dir, status, submit)
//   - any path with /assets prefix (the wizard's JS/CSS bundles served
//     from the embedded //go:embed dist/)
//
// Once config.json exists, the middleware is a no-op for every request.
func RedirectMiddleware(dataDir string) func(http.Handler) http.Handler {
	cfgPath := filepath.Join(dataDir, "storage", "config.json")
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/setup" ||
				strings.HasPrefix(r.URL.Path, "/api/v1/setup") ||
				strings.HasPrefix(r.URL.Path, "/assets") {
				next.ServeHTTP(w, r)
				return
			}

			if _, err := os.Stat(cfgPath); errors.Is(err, fs.ErrNotExist) {
				http.Redirect(w, r, "/setup", http.StatusFound)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
