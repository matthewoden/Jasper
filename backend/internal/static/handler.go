package static

import (
	"io/fs"
	"net/http"
	"strings"
)

// Handler returns an http.Handler that serves the embedded SPA. SPA
// routes (paths that don't match a real file) fall back to index.html.
// MUST be mounted LAST in the chi router (Pitfall 13) — if mounted
// before the API the SPA fallback will swallow /api/v1/* requests and
// return HTML, breaking the typed client.
func Handler() http.Handler {
	return handlerFor(FS())
}

// handlerFor is the testable form of Handler — accepts any fs.FS so
// tests can populate a synthetic dist/ tree without touching the
// embedded one. Production callers use Handler().
//
// Implementation note: we deliberately do NOT use http.FileServer for the
// index.html / SPA-fallback paths. http.FileServer applies a canonical-URL
// redirect for any request whose path ends in `/index.html`, returning
// 301 → `/`. That breaks both the direct `/index.html` test (we want 200,
// not 301) and the SPA-fallback path (cloning the request to
// `/index.html` would trigger the same 301). Instead we serve the file
// bytes ourselves for index.html and only delegate to FileServer for
// real, non-index assets.
func handlerFor(fsys fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(fsys))

	serveIndex := func(w http.ResponseWriter) {
		body, err := fs.ReadFile(fsys, "index.html")
		if err != nil {
			http.Error(w, "index.html missing from embedded SPA", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")

		// `/` and `/index.html` both serve the index directly to avoid
		// http.FileServer's automatic 301 to canonical URL.
		if path == "" || path == "index.html" {
			serveIndex(w)
			return
		}

		// SPA fallback: any path that isn't a real embedded file gets the
		// index served back so client-side routing can take over.
		if _, err := fs.Stat(fsys, path); err != nil {
			serveIndex(w)
			return
		}

		// Differentiated cache headers per ARCHITECTURE.md §8.3.
		// Vite emits content-hashed filenames under assets/ (e.g.
		// assets/index-abc123.js) so they are immutable.
		if strings.HasPrefix(path, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
		fileServer.ServeHTTP(w, r)
	})
}
