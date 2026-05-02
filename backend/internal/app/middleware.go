package app

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// requestLogger logs each HTTP request via slog at INFO level. Wraps
// the response writer so we capture status + bytes written. RequestID
// is sourced from chi/middleware.RequestID (mounted upstream of this
// in app.New) — Pitfall: if RequestID is mounted AFTER this middleware
// the logged id will be empty. The order in app.New is enforced.
func requestLogger(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)
			log.Info("http",
				"method", r.Method,
				"path", r.URL.Path,
				"status", ww.Status(),
				"bytes", ww.BytesWritten(),
				"duration_ms", time.Since(start).Milliseconds(),
				"request_id", middleware.GetReqID(r.Context()),
			)
		})
	}
}

// maxRequestBodyBytes caps every API request body at 10 MiB. The
// strict-server middleware deserializes JSON bodies into Go strings
// before the handler runs, so without a cap a single PUT with a giant
// Content-Length forces the server to allocate the whole payload into
// memory before failing. 10 MiB is two orders of magnitude above any
// plausible markdown note.
const maxRequestBodyBytes = 10 << 20 // 10 MiB

// maxBodyBytes wraps each request body in http.MaxBytesReader. When
// the body exceeds the cap, subsequent reads fail with a typed
// MaxBytesError and the strict-server returns 400. The wrapper is
// installed under r.Route("/api/v1", ...) so it only affects API
// routes — SPA traffic continues unbounded.
func maxBodyBytes(limit int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body != nil {
				r.Body = http.MaxBytesReader(w, r.Body, limit)
			}
			next.ServeHTTP(w, r)
		})
	}
}
