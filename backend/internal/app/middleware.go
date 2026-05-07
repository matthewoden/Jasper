package app

import (
	"log/slog"
	"net/http"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/matthewoden/jasper/backend/internal/notes"
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

// maxSessionIDHeaderLen is the maximum allowed length for the
// X-Session-ID header. Values longer than this are silently coerced
// to "" (server-originated semantics) — T-04-03 mitigation.
const maxSessionIDHeaderLen = 128

// sessionIDMiddleware extracts the X-Session-ID header and propagates
// it via context.Value (key defined in notes/context.go). The
// frontend's generateOrLoadSessionId() helper is the source of truth.
// Both the WS handshake (?session_id=) and this header carry the SAME
// value, so origin filtering works (Pitfall 1 in RESEARCH.md).
//
// SECURITY (T-04-03):
//   - Length cap: 128 chars. Anything longer is silently coerced to ""
//     so the broadcaster sees "server-originated" and the bad value is
//     never echoed in any broadcast envelope.
//   - Control characters are rejected via unicode.IsControl, which
//     covers BOTH the ASCII C0 range (U+0000–U+001F) AND the Unicode
//     C1 range (U+0080–U+009F). DEL (U+007F) is not in IsControl's
//     categories so we keep the explicit check. WR-02 fix — the prior
//     `ch < 0x20 || ch == 0x7F` loop only covered ASCII controls,
//     contradicting the doc claim that "control characters are
//     rejected" for non-ASCII inputs.
//   - Empty value is allowed (curl, automation, server-originated
//     paths) — see Pitfall 5 in RESEARCH.md.
//   - Pitfall 5 (origin spoofing): a malicious client could send any
//     X-Session-ID; server uses the value only for origin filtering.
//     Worst case: a tab's own broadcasts are suppressed. v1 single-user
//     self-host posture — not a credible threat.
func sessionIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sid := r.Header.Get("X-Session-ID")
		if len(sid) > maxSessionIDHeaderLen {
			sid = ""
		} else {
			for _, ch := range sid {
				if unicode.IsControl(ch) || ch == 0x7F {
					sid = ""
					break
				}
			}
		}
		ctx := notes.WithSessionID(r.Context(), sid)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
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
