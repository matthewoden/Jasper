package firstrun

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func nextHandler(called *bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		*called = true
		w.WriteHeader(http.StatusOK)
	})
}

func TestRedirectMiddleware(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name           string
		path           string
		seedConfigJSON bool
		wantStatus     int
		wantLocation   string
	}{
		{name: "exact /setup passes through (no config)", path: "/setup"},
		{name: "/api/v1/setup passes through (no config)", path: "/api/v1/setup"},
		{name: "/api/v1/setup/validate-data-dir passes through (no config)", path: "/api/v1/setup/validate-data-dir"},
		{name: "/api/v1/setup/status passes through (no config)", path: "/api/v1/setup/status"},
		{name: "/assets/index.js passes through (no config)", path: "/assets/index.js"},
		{name: "/ redirects when no config", path: "/", wantStatus: http.StatusFound, wantLocation: "/setup"},
		{name: "/notes/abc redirects when no config", path: "/notes/abc", wantStatus: http.StatusFound, wantLocation: "/setup"},
		{name: "/api/v1/notes redirects when no config", path: "/api/v1/notes", wantStatus: http.StatusFound, wantLocation: "/setup"},
		{name: "/ passes through when config exists", path: "/", seedConfigJSON: true},
		{name: "/notes/abc passes through when config exists", path: "/notes/abc", seedConfigJSON: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			dataDir := t.TempDir()
			if tc.seedConfigJSON {
				storageDir := filepath.Join(dataDir, "storage")
				if err := os.MkdirAll(storageDir, 0o700); err != nil {
					t.Fatalf("mkdir storage: %v", err)
				}
				if err := os.WriteFile(filepath.Join(storageDir, "config.json"), []byte("{}"), 0o600); err != nil {
					t.Fatalf("write config.json: %v", err)
				}
			}

			called := false
			h := RedirectMiddleware(dataDir)(nextHandler(&called))
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if tc.wantStatus != 0 {
				if rec.Code != tc.wantStatus {
					t.Fatalf("status: got %d want %d", rec.Code, tc.wantStatus)
				}
				if loc := rec.Header().Get("Location"); loc != tc.wantLocation {
					t.Fatalf("Location: got %q want %q", loc, tc.wantLocation)
				}
				if called {
					t.Fatalf("next.ServeHTTP called but redirect expected")
				}
				return
			}

			if !called {
				t.Fatalf("next.ServeHTTP NOT called for path %q (status=%d location=%q)",
					tc.path, rec.Code, rec.Header().Get("Location"))
			}
			if rec.Code != http.StatusOK {
				t.Fatalf("status: got %d want 200", rec.Code)
			}
		})
	}
}

// TestRedirectMiddleware_StatErrorFallsThrough verifies that a non-not-exist
// error from os.Stat does NOT trigger a redirect (we don't have a portable
// way to provoke a permission-denied here, so this test exercises the
// happy-path code coverage on a config that exists — the relevant code path
// is the `errors.Is(err, fs.ErrNotExist)` guard, not the fall-through).
func TestRedirectMiddleware_ConfigPresent_NoRedirect(t *testing.T) {
	t.Parallel()
	dataDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataDir, "storage"), 0o700); err != nil {
		t.Fatalf("mkdir storage: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "storage", "config.json"), []byte("{}"), 0o600); err != nil {
		t.Fatalf("write config.json: %v", err)
	}
	called := false
	h := RedirectMiddleware(dataDir)(nextHandler(&called))
	req := httptest.NewRequest(http.MethodGet, "/anything", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if !called {
		t.Fatalf("expected next.ServeHTTP called with present config; got status=%d", rec.Code)
	}
}
