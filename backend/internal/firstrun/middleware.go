// Package firstrun implements the first-run wizard server gate.
//
// The side-effecting work lives here rather than in internal/api so it is
// testable without spinning up a chi router.
package firstrun

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"strings"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

// RedirectMiddleware 302-redirects to /setup when config.json is absent.
//
// Deprecated: the no-vault state is handled by the lifecycle's vaultMode
// branch. Retained for one minor version to ease testing rollback; NOT mounted
// on the live router.
func RedirectMiddleware(dataDir string) func(http.Handler) http.Handler {
	cfgPath := vault.ConfigPath(dataDir)
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
