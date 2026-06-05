package static

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func fakeDist() fstest.MapFS {
	return fstest.MapFS{
		"index.html": &fstest.MapFile{
			Data: []byte(`<!doctype html><html><head><title>Jasper</title></head><body><div id="root"></div></body></html>`),
		},
		"assets/index-abc123.js": &fstest.MapFile{
			Data: []byte(`console.log("test bundle")`),
		},
		"favicon.ico": &fstest.MapFile{
			Data: []byte{0x00},
		},
	}
}

func drainBody(t *testing.T, resp *http.Response) []byte {
	t.Helper()
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return body
}

// Test ST1: GET / → returns the bytes of dist/index.html with text/html
// Content-Type and the no-cache header.
func TestStaticHandler_RootServesIndex(t *testing.T) {
	h := handlerFor(fakeDist())
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	h.ServeHTTP(rr, req)

	resp := rr.Result()
	body := drainBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	if !strings.Contains(string(body), `<div id="root"></div>`) {
		t.Errorf("body did not contain index.html marker: %s", body)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type: got %q, want text/html*", ct)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("Cache-Control: got %q, want %q", cc, "no-cache")
	}
}

// Test ST2: GET /assets/foo-abc123.js → returns the file with the
// immutable Cache-Control header.
func TestStaticHandler_AssetsImmutable(t *testing.T) {
	h := handlerFor(fakeDist())
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/assets/index-abc123.js", nil)
	h.ServeHTTP(rr, req)

	resp := rr.Result()
	body := drainBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	if !strings.Contains(string(body), "test bundle") {
		t.Errorf("body did not match asset payload: %s", body)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
		t.Errorf("Cache-Control: got %q, want immutable", cc)
	}
}

// Test ST3: GET /index.html → returns index.html with no-cache.
func TestStaticHandler_IndexHTMLNoCacheOnDirectHit(t *testing.T) {
	h := handlerFor(fakeDist())
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/index.html", nil)
	h.ServeHTTP(rr, req)

	resp := rr.Result()
	body := drainBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("Cache-Control: got %q, want %q", cc, "no-cache")
	}
}

// Test ST4: GET /notes/some-id (an SPA route, NOT a real file) →
// returns index.html with no-cache (SPA fallback).
func TestStaticHandler_SPAFallbackForUnknownPath(t *testing.T) {
	h := handlerFor(fakeDist())
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/notes/some-route-id", nil)
	h.ServeHTTP(rr, req)

	resp := rr.Result()
	body := drainBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	if !strings.Contains(string(body), `<div id="root"></div>`) {
		t.Errorf("SPA fallback did not return index.html: %s", body)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("Cache-Control: got %q, want %q", cc, "no-cache")
	}
}

// Test ST5: A non-asset, non-index real file (favicon.ico) gets the
// generic 1-hour cache header.
func TestStaticHandler_OtherFilesShortCache(t *testing.T) {
	h := handlerFor(fakeDist())
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/favicon.ico", nil)
	h.ServeHTTP(rr, req)

	resp := rr.Result()
	_ = drainBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d, want 200", resp.StatusCode)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "public, max-age=3600" {
		t.Errorf("Cache-Control: got %q, want %q", cc, "public, max-age=3600")
	}
}

// Test that the production Handler() returns a non-nil handler that
// at least responds to a request — proves the embedded FS plumbing
// is wired (the .gitkeep alone is NOT a valid index.html, so the
// fallback path is exercised).
func TestStaticHandler_ProductionFSWires(t *testing.T) {
	h := Handler()
	if h == nil {
		t.Fatal("Handler() returned nil")
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/some-route", nil)
	h.ServeHTTP(rr, req)
}
