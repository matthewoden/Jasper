package app

import (
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/matthewoden/jasper/backend/internal/api"
	"github.com/matthewoden/jasper/backend/internal/netbind"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

func requestLogger(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)
			log.Info(
				"http",
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

const maxSessionIDHeaderLen = 128

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

const maxAttachmentBodyBytes = 200 << 20

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

const cspHeaderValue = "default-src 'self'; " +
	"img-src 'self' data: blob:; " +
	"script-src 'self'; " +
	"connect-src 'self' ws: wss:; " +
	"font-src 'self' data:; " +
	"style-src 'self' 'unsafe-inline'"

// securityHeadersMiddleware sets the app-wide headers. Routes that stream
// user-controlled bytes out of the vault get the strict per-response CSP
// instead, so a planted SVG cannot execute as a document in the app origin.
// api.ServeFile sets those headers itself too; this covers the generated
// attachment handler, which cannot add headers of its own.
func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		if api.IsRawFilePath(r.URL.Path) {
			h.Set("Content-Security-Policy", api.RawFileCSP)
		} else {
			h.Set("Content-Security-Policy", cspHeaderValue)
		}
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

// hostAllowlistMiddleware rejects any request whose Host header names a host
// Jasper is not serving, closing DNS rebinding at the router root.
//
// csrfOriginMiddleware cannot cover this: GET is a safe method and bypasses
// it entirely, and read-only exfiltration is the whole prize for a notes app.
//
// The allowlist rules — including the --bind and 0.0.0.0 cases — live in
// netbind.HostAllowlist, shared with the WebSocket upgrade and the MCP
// listener so all three answer "is this us?" the same way.
func hostAllowlistMiddleware(listenAddr string) func(http.Handler) http.Handler {
	allowlist := netbind.NewHostAllowlist(listenAddr)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !allowlist.Allows(r.Host) {
				http.Error(w, "forbidden Host", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

var csrfSafeMethods = map[string]bool{
	http.MethodGet:     true,
	http.MethodHead:    true,
	http.MethodOptions: true,
}

// csrfOriginMiddleware rejects mutating requests (PUT/POST/DELETE) whose Origin
// is present but not in the set derived from listenAddr. Safe methods and absent
// Origin pass (a missing Origin is a non-browser client, not a CSRF vector).
// For 0.0.0.0 binds, any Origin whose port matches the configured port passes.
func csrfOriginMiddleware(listenAddr string) func(http.Handler) http.Handler {
	bindHost, port, err := net.SplitHostPort(listenAddr)
	if err != nil {
		bindHost, port = "127.0.0.1", "6683"
	}
	allIfaces := bindHost == "0.0.0.0"

	allowed := make(map[string]bool)
	for _, o := range allowedOrigins(listenAddr) {
		allowed[o] = true
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if csrfSafeMethods[r.Method] {
				next.ServeHTTP(w, r)
				return
			}
			origin := r.Header.Get("Origin")
			if origin == "" {
				next.ServeHTTP(w, r)
				return
			}
			if allowed[origin] {
				next.ServeHTTP(w, r)
				return
			}
			if allIfaces {
				if u, parseErr := url.Parse(origin); parseErr == nil {
					if _, originPort, splitErr := net.SplitHostPort(u.Host); splitErr == nil && originPort == port {
						next.ServeHTTP(w, r)
						return
					}
				}
			}
			http.Error(w, "forbidden Origin", http.StatusForbidden)
		})
	}
}
