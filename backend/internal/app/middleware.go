package app

import (
	"log/slog"
	"net/http"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

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
