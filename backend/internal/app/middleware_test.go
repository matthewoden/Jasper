package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
	// No X-Session-ID header set.
	h.ServeHTTP(httptest.NewRecorder(), req)
	if captured != "" {
		t.Errorf("got %q, want empty string", captured)
	}
}

// TestSessionIDMiddleware_RejectsOverCap: a header value longer than
// maxSessionIDHeaderLen (128) is silently coerced to "" — T-04-03.
func TestSessionIDMiddleware_RejectsOverCap(t *testing.T) {
	var captured string
	inner := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		captured = notes.SessionIDFromContext(r.Context())
	})
	h := sessionIDMiddleware(inner)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Session-ID", strings.Repeat("a", maxSessionIDHeaderLen+1)) // 129 chars
	h.ServeHTTP(httptest.NewRecorder(), req)
	if captured != "" {
		t.Errorf("over-cap value should coerce to empty; got %q", captured)
	}
}

// TestSessionIDMiddleware_RejectsControlChars: a header value containing
// any control character (0x00..0x1F or 0x7F) is silently coerced to ""
// — T-04-03 header injection mitigation.
func TestSessionIDMiddleware_RejectsControlChars(t *testing.T) {
	var captured string
	inner := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		captured = notes.SessionIDFromContext(r.Context())
	})
	h := sessionIDMiddleware(inner)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Session-ID", "abc\x00def") // null byte injection
	h.ServeHTTP(httptest.NewRecorder(), req)
	if captured != "" {
		t.Errorf("control-char value should coerce to empty; got %q", captured)
	}
}

// TestSessionIDMiddleware_RejectsC1Controls (WR-02 fix): the Unicode C1
// control range (U+0080–U+009F) must also be rejected. Prior to the
// unicode.IsControl switchover, the loop only filtered ASCII controls
// (rune < 0x20 || rune == 0x7F), letting C1 controls through despite
// the docstring claim that "control characters are rejected."
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
