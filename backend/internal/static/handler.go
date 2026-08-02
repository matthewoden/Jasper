package static

import (
	"io/fs"
	"net/http"
	"strings"
)

// Handler returns an http.Handler that serves the embedded SPA. SPA
// routes (paths that don't match a real file) fall back to index.html.
// MUST be mounted LAST in the chi router — if mounted
// before the API the SPA fallback will swallow /api/v1/* requests and
// return HTML, breaking the typed client.
func Handler() http.Handler {
	return handlerFor(FS())
}

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

		if path == "" || path == "index.html" {
			serveIndex(w)
			return
		}

		if _, err := fs.Stat(fsys, path); err != nil {
			serveIndex(w)
			return
		}

		if strings.HasPrefix(path, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
		fileServer.ServeHTTP(w, r)
	})
}
