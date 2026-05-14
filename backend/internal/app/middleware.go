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

// maxAttachmentBodyBytes is the body cap applied to the /api/v1 route group.
// It is larger than maxRequestBodyBytes to accommodate attachment uploads (up to
// 100 MiB per D-29 / ATTACH-01). The attachment handler enforces its own
// io.LimitReader(100 MiB+1) cap and returns HTTP 413 for oversized files;
// the middleware limit must be ABOVE the handler cap so MaxBytesReader does not
// fire before the handler can inspect the body and return 413 cleanly.
//
// Plan 07-13 (Rule 1 bug fix): the original 10 MiB middleware limit caused the
// server to return HTTP 500 (MaxBytesError from MaxBytesReader) instead of
// HTTP 413 (from the handler's own limit check) for attachment uploads > 10 MiB.
// Raising this limit to 200 MiB ensures that bodies up to 100 MiB + multipart
// framing overhead reach the handler intact, while the handler's LimitReader
// enforces the actual 100 MiB cap and returns 413 to the client.
//
// Trade-off: the worst-case memory DoS for non-attachment routes is 200 MiB
// (down from ∞ without this cap). Jasper binds to localhost only and targets
// single-user self-host — acceptable for v1.
const maxAttachmentBodyBytes = 200 << 20 // 200 MiB — above handler's 100 MiB LimitReader cap

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

// cspHeaderValue is the strict Content-Security-Policy applied to every
// response (D-33 / SECURITY-01 verbatim).
//
//	default-src 'self'               — no third-party origins for any
//	                                   resource type by default
//	img-src 'self' data: blob:       — internal images + inline data:
//	                                   + the external-image widget's
//	                                   blob URLs (Plan 05-08)
//	script-src 'self'                — NO inline scripts, NO eval; the
//	                                   theme bootstrap (Plan 05-10)
//	                                   ships as /theme-bootstrap.js,
//	                                   NOT as <script>...</script>
//	connect-src 'self' ws: wss:      — fetch + WebSocket to same-origin
//	                                   only (Phase 4 /ws is same-origin)
//	font-src 'self' data:            — system + base64 fonts only
//	style-src 'self' 'unsafe-inline' — Tailwind v4 + Radix emit inline
//	                                   styles at runtime; v1 accepts
//	                                   'unsafe-inline'. Phase 8+
//	                                   revisits with nonce-based CSP
//	                                   per CONTEXT.md Deferred Ideas.
const cspHeaderValue = "default-src 'self'; " +
	"img-src 'self' data: blob:; " +
	"script-src 'self'; " +
	"connect-src 'self' ws: wss:; " +
	"font-src 'self' data:; " +
	"style-src 'self' 'unsafe-inline'"

// securityHeadersMiddleware emits CSP (SECURITY-01) and
// Referrer-Policy: no-referrer (SECURITY-04) on EVERY response —
// HTML, API JSON, attachments, the /ws upgrade response, and the
// boot-error static pages from disk_full_handler.go.
//
// Mount order (D-35): mount AFTER middleware.RequestID + Recoverer
// and BEFORE requestLogger so even Recoverer-wrapped 500 panic
// responses carry the headers, and the request log line is emitted
// for a request that already had its security headers set.
//
// Idempotency: uses w.Header().Set (NOT Add) so a downstream handler
// that re-sets the same header overwrites cleanly without duplicates
// (Pitfall: Add accumulates; Set replaces).
//
// The companion defensive-trio headers (X-Content-Type-Options,
// X-Frame-Options) cost nothing and complement the strict CSP.
func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", cspHeaderValue)
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}
