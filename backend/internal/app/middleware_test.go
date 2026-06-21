package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// TestSessionIDMiddleware_PropagatesHeaderToContext: a valid X-Session-ID
// header is extracted and stored in the request context so downstream
// handlers can call notes.SessionIDFromContext.
func TestSessionIDMiddleware_PropagatesHeaderToContext(t *testing.T) {
	var captured string
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = notes.SessionIDFromContext(r.Context())
		w.WriteHeader(200)
	})
	h := sessionIDMiddleware(inner)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/notes", nil)
	req.Header.Set("X-Session-ID", "abc-123")
	h.ServeHTTP(httptest.NewRecorder(), req)

	if captured != "abc-123" {
		t.Errorf("got %q, want %q", captured, "abc-123")
	}
}

// TestSessionIDMiddleware_EmptyHeaderStillPropagates: a missing (empty)
// X-Session-ID is propagated as "" — the permissive server-originated
// semantics (broadcast reaches every tab including the originator).
func TestSessionIDMiddleware_EmptyHeaderStillPropagates(t *testing.T) {
	var captured string
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = notes.SessionIDFromContext(r.Context())
		w.WriteHeader(200)
	})
	h := sessionIDMiddleware(inner)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/notes", nil)

	h.ServeHTTP(httptest.NewRecorder(), req)
	if captured != "" {
		t.Errorf("got %q, want empty string", captured)
	}
}

// TestSessionIDMiddleware_RejectsOverCap: a header value longer than
// maxSessionIDHeaderLen (128) is silently coerced to "".
func TestSessionIDMiddleware_RejectsOverCap(t *testing.T) {
	var captured string
	inner := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		captured = notes.SessionIDFromContext(r.Context())
	})
	h := sessionIDMiddleware(inner)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Session-ID", strings.Repeat("a", maxSessionIDHeaderLen+1))
	h.ServeHTTP(httptest.NewRecorder(), req)
	if captured != "" {
		t.Errorf("over-cap value should coerce to empty; got %q", captured)
	}
}

// TestSessionIDMiddleware_RejectsControlChars: a header value containing
// any control character (0x00..0x1F or 0x7F) is silently coerced to ""
// to prevent header injection.
func TestSessionIDMiddleware_RejectsControlChars(t *testing.T) {
	var captured string
	inner := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		captured = notes.SessionIDFromContext(r.Context())
	})
	h := sessionIDMiddleware(inner)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Session-ID", "abc\x00def")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if captured != "" {
		t.Errorf("control-char value should coerce to empty; got %q", captured)
	}
}

// TestSessionIDMiddleware_RejectsC1Controls: the Unicode C1 control range
// (U+0080–U+009F) must also be rejected. Prior to the unicode.IsControl
// switchover, the loop only filtered ASCII controls (rune < 0x20 || rune == 0x7F),
// letting C1 controls through despite the docstring claim that "control
// characters are rejected."
func TestSessionIDMiddleware_RejectsC1Controls(t *testing.T) {
	cases := []struct {
		name string
		sid  string
	}{
		{"u+0080-padding-character", "abc\u0080def"},
		{"u+0085-next-line", "abc\u0085def"},
		{"u+009F-app-program-cmd", "abc\u009fdef"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var captured string
			inner := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				captured = notes.SessionIDFromContext(r.Context())
			})
			h := sessionIDMiddleware(inner)
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.Header.Set("X-Session-ID", tc.sid)
			h.ServeHTTP(httptest.NewRecorder(), req)
			if captured != "" {
				t.Errorf("C1 control %q should coerce to empty; got %q", tc.sid, captured)
			}
		})
	}
}

// TestSecurityHeadersMiddleware_SetsHeadersOnEveryResponse — happy
// path: every response carries CSP + Referrer-Policy + the defensive
// trio. Verbatim header value match for CSP.
func TestSecurityHeadersMiddleware_SetsHeadersOnEveryResponse(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	h := securityHeadersMiddleware(inner)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/notes", nil)
	h.ServeHTTP(rec, req)

	if got, want := rec.Header().Get("Content-Security-Policy"), cspHeaderValue; got != want {
		t.Errorf("CSP:\n got  %q\n want %q", got, want)
	}
	if got, want := rec.Header().Get("Referrer-Policy"), "no-referrer"; got != want {
		t.Errorf("Referrer-Policy: got %q, want %q", got, want)
	}
	if got, want := rec.Header().Get("X-Content-Type-Options"), "nosniff"; got != want {
		t.Errorf("X-Content-Type-Options: got %q, want %q", got, want)
	}
	if got, want := rec.Header().Get("X-Frame-Options"), "DENY"; got != want {
		t.Errorf("X-Frame-Options: got %q, want %q", got, want)
	}
}

// TestSecurityHeadersMiddleware_HeadersPresentOn500 — Recoverer
// returns 500 when the inner handler panics. Headers MUST be set
// before the panic (we set them first, THEN call next.ServeHTTP),
// so the 500 response carries them too.
func TestSecurityHeadersMiddleware_HeadersPresentOn500(t *testing.T) {
	inner := http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		panic("boom")
	})

	recovered := middleware.Recoverer(inner)
	h := securityHeadersMiddleware(recovered)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/notes", nil)
	h.ServeHTTP(rec, req)

	if rec.Code != 500 {
		t.Fatalf("status: got %d, want 500", rec.Code)
	}
	if got := rec.Header().Get("Content-Security-Policy"); got != cspHeaderValue {
		t.Errorf("CSP missing on 500 panic response: got %q", got)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Errorf("Referrer-Policy missing on 500 panic response: got %q", got)
	}
}

// TestSecurityHeadersMiddleware_CSPDirectives — assert each named
// directive is present in the CSP header value. Catches drift where
// someone reorders or accidentally drops one.
func TestSecurityHeadersMiddleware_CSPDirectives(t *testing.T) {
	wantDirectives := []string{
		"default-src 'self'",
		"img-src 'self' data: blob:",
		"script-src 'self'",
		"connect-src 'self' ws: wss:",
		"font-src 'self' data:",
		"style-src 'self' 'unsafe-inline'",
	}
	for _, d := range wantDirectives {
		if !strings.Contains(cspHeaderValue, d) {
			t.Errorf("cspHeaderValue missing directive %q\n got %q", d, cspHeaderValue)
		}
	}

	if strings.Contains(cspHeaderValue, "'unsafe-eval'") {
		t.Errorf("cspHeaderValue must NOT contain 'unsafe-eval'")
	}
}

// TestSecurityHeadersMiddleware_UsesSetNotAdd — defense-in-depth:
// if a downstream handler re-Sets the same header, the value is
// replaced, not duplicated. Pitfall: Header().Add accumulates.
func TestSecurityHeadersMiddleware_UsesSetNotAdd(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Referrer-Policy", "strict-origin")
		w.WriteHeader(200)
	})
	h := securityHeadersMiddleware(inner)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	h.ServeHTTP(rec, req)

	if got := rec.Header().Values("Referrer-Policy"); len(got) != 1 {
		t.Errorf("Referrer-Policy values: got %d, want 1; values=%v", len(got), got)
	}
}

// sentinel next handler for CSRF tests — records whether it was called.
func csrfSentinel(t *testing.T, called *bool) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		*called = true
		w.WriteHeader(http.StatusOK)
	})
}

// TestCSRFOriginMiddleware_SafeMethodPassthrough: GET with no Origin header
// passes through the CSRF middleware unconditionally (safe method).
func TestCSRFOriginMiddleware_SafeMethodPassthrough(t *testing.T) {
	called := false
	origins := allowedOrigins("127.0.0.1:6683")
	h := csrfOriginMiddleware(origins)(csrfSentinel(t, &called))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/notes", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if !called {
		t.Error("expected next handler to be called for GET with no Origin")
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

// TestCSRFOriginMiddleware_SameOriginAllow: PUT with the same-origin
// loopback Origin passes the CSRF check.
func TestCSRFOriginMiddleware_SameOriginAllow(t *testing.T) {
	called := false
	origins := allowedOrigins("127.0.0.1:6683")
	h := csrfOriginMiddleware(origins)(csrfSentinel(t, &called))

	req := httptest.NewRequest(http.MethodPut, "/api/v1/notes/1", nil)
	req.Header.Set("Origin", "http://127.0.0.1:6683")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if !called {
		t.Error("expected next handler to be called for PUT with same-origin loopback")
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

// TestCSRFOriginMiddleware_EmptyOriginReject: PUT with empty Origin
// is rejected with 403.
func TestCSRFOriginMiddleware_EmptyOriginReject(t *testing.T) {
	called := false
	origins := allowedOrigins("127.0.0.1:6683")
	h := csrfOriginMiddleware(origins)(csrfSentinel(t, &called))

	req := httptest.NewRequest(http.MethodPut, "/api/v1/notes/1", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if called {
		t.Error("expected next handler NOT to be called for PUT with empty Origin")
	}
	if rec.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rec.Code)
	}
}

// TestCSRFOriginMiddleware_ForeignOriginReject: PUT with a foreign Origin
// is rejected with 403.
func TestCSRFOriginMiddleware_ForeignOriginReject(t *testing.T) {
	called := false
	origins := allowedOrigins("127.0.0.1:6683")
	h := csrfOriginMiddleware(origins)(csrfSentinel(t, &called))

	req := httptest.NewRequest(http.MethodPut, "/api/v1/notes/1", nil)
	req.Header.Set("Origin", "http://evil.com")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if called {
		t.Error("expected next handler NOT to be called for PUT with foreign Origin")
	}
	if rec.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rec.Code)
	}
}

// TestCSRFOriginMiddleware_DeleteAllows: DELETE with allowed Origin passes.
func TestCSRFOriginMiddleware_DeleteAllows(t *testing.T) {
	called := false
	origins := allowedOrigins("127.0.0.1:6683")
	h := csrfOriginMiddleware(origins)(csrfSentinel(t, &called))

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/notes/1", nil)
	req.Header.Set("Origin", "http://localhost:6683")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if !called {
		t.Error("expected next handler to be called for DELETE with allowed Origin")
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

// TestCSRFOriginMiddleware_AllIfacesPortMatch: when bound to 0.0.0.0, a LAN
// browser Origin whose port matches the configured port passes; a request
// from the same IP with a wrong port is rejected.
func TestCSRFOriginMiddleware_AllIfacesPortMatch(t *testing.T) {
	origins := allowedOrigins("0.0.0.0:6683")
	h := csrfOriginMiddleware(origins)

	// LAN origin with correct port — should pass.
	t.Run("correct_port_allows", func(t *testing.T) {
		called := false
		req := httptest.NewRequest(http.MethodPut, "/api/v1/notes/1", nil)
		req.Header.Set("Origin", "http://192.168.1.5:6683")
		rec := httptest.NewRecorder()
		h(csrfSentinel(t, &called)).ServeHTTP(rec, req)
		if !called {
			t.Error("expected next handler to be called for LAN origin with correct port")
		}
		if rec.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", rec.Code)
		}
	})

	// LAN origin with wrong port — should be rejected.
	t.Run("wrong_port_rejects", func(t *testing.T) {
		called := false
		req := httptest.NewRequest(http.MethodPut, "/api/v1/notes/1", nil)
		req.Header.Set("Origin", "http://192.168.1.5:9999")
		rec := httptest.NewRecorder()
		h(csrfSentinel(t, &called)).ServeHTTP(rec, req)
		if called {
			t.Error("expected next handler NOT to be called for LAN origin with wrong port")
		}
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", rec.Code)
		}
	})
}
