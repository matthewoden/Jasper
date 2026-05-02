package app

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// newTestApp returns a *App rooted at a fresh temp directory with the
// notes/ + storage/ subdirs already created. We seed scratchpad.md
// here too so the API tests have a real file to read.
func newTestApp(t *testing.T) (*App, string) {
	t.Helper()
	dir := t.TempDir()
	if err := EnsureDataDir(dir); err != nil {
		t.Fatalf("EnsureDataDir: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := SeedScratchpadIfMissing(dir, logger); err != nil {
		t.Fatalf("SeedScratchpadIfMissing: %v", err)
	}
	a, err := New(Config{
		DataDir:    dir,
		ListenAddr: "127.0.0.1:0",
		Logger:     logger,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return a, dir
}

// Test AP1 — GET /api/v1/notes/{ScratchpadUUID} returns 200 + JSON body
// containing the welcome content. This proves the chi mount order works
// (Pitfall 13): the API handler runs, NOT the SPA fallback.
func TestApp_GetScratchpadReturns200JSON(t *testing.T) {
	a, _ := newTestApp(t)
	ts := httptest.NewServer(a.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/notes/" + notes.ScratchpadUUID.String())
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type: got %q, want application/json*", ct)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	var got struct {
		ID        string `json:"id"`
		Path      string `json:"path"`
		Content   string `json:"content"`
		UpdatedAt string `json:"updated_at"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.ID != notes.ScratchpadUUID.String() {
		t.Errorf("id: got %q, want %q", got.ID, notes.ScratchpadUUID.String())
	}
	if got.Path != notes.ScratchpadRelPath {
		t.Errorf("path: got %q, want %q", got.Path, notes.ScratchpadRelPath)
	}
	if !strings.Contains(got.Content, "Welcome to Jasper") {
		t.Errorf("content did not contain welcome marker: %s", got.Content)
	}
}

// Test AP1b — Pitfall 13 gate: GET /api/v1/no-such-route MUST return
// JSON (chi 404), NOT HTML from the SPA fallback. This is the load-
// bearing assertion: if the SPA fallback intercepts /api/v1/* the
// typed openapi-fetch client breaks and the regression is silent in
// the browser until a user hits a 404.
func TestApp_UnknownAPIRouteIsNotHTML(t *testing.T) {
	a, _ := newTestApp(t)
	ts := httptest.NewServer(a.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/no-such-route")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if strings.Contains(strings.ToLower(string(body)), "<html") {
		t.Errorf("Pitfall 13 regression: /api/v1/* returned HTML: %s", body)
	}
	// chi's default 404 returns plain text "404 page not found\n" —
	// any non-HTML response is acceptable here. We do NOT assert
	// status==404 because the test's only invariant is "no HTML".
}

// Test AP1c — GET / returns the embedded SPA's index.html. Under
// the test setup the embedded dist/ contains only .gitkeep, so the
// SPA fallback path is exercised but the http.FileServer may emit
// a 404 because no index.html exists. We assert only that the
// response is NOT an API JSON error envelope.
func TestApp_RootDoesNotHitAPI(t *testing.T) {
	a, _ := newTestApp(t)
	ts := httptest.NewServer(a.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)

	// Should NOT be a json error envelope from the API stack.
	if strings.HasPrefix(strings.TrimSpace(string(body)), `{"code":`) {
		t.Errorf("root path leaked into API stack: %s", body)
	}
}

// Test AP2 — SeedScratchpadIfMissing creates the file when absent
// and writes notes.ScratchpadWelcome bytes verbatim.
func TestSeedScratchpadIfMissing_CreatesFile(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureDataDir(dir); err != nil {
		t.Fatalf("EnsureDataDir: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	if err := SeedScratchpadIfMissing(dir, logger); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(dir, "notes", notes.ScratchpadRelPath))
	if err != nil {
		t.Fatalf("readfile: %v", err)
	}
	if string(got) != notes.ScratchpadWelcome {
		t.Errorf("seeded bytes did not match ScratchpadWelcome:\ngot:  %q\nwant: %q", got, notes.ScratchpadWelcome)
	}
}

// Test AP3 — SeedScratchpadIfMissing is idempotent: if the file
// already exists with custom content, it is NOT overwritten.
func TestSeedScratchpadIfMissing_IdempotentOnExisting(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureDataDir(dir); err != nil {
		t.Fatalf("EnsureDataDir: %v", err)
	}
	custom := []byte("# my customized scratchpad\nthis was here first")
	target := filepath.Join(dir, "notes", notes.ScratchpadRelPath)
	if err := os.WriteFile(target, custom, 0o644); err != nil {
		t.Fatalf("pre-write: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := SeedScratchpadIfMissing(dir, logger); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("readfile: %v", err)
	}
	if string(got) != string(custom) {
		t.Errorf("seed overwrote existing file:\ngot:  %q\nwant: %q", got, custom)
	}
}

// Test AP4 — EnsureDataDir creates both notes/ and storage/.
func TestEnsureDataDir_CreatesNotesAndStorage(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "fresh")
	if err := EnsureDataDir(root); err != nil {
		t.Fatalf("EnsureDataDir: %v", err)
	}
	for _, sub := range []string{"notes", "storage"} {
		info, err := os.Stat(filepath.Join(root, sub))
		if err != nil {
			t.Errorf("expected %s to exist: %v", sub, err)
			continue
		}
		if !info.IsDir() {
			t.Errorf("%s: not a directory", sub)
		}
	}
}

// Test AP5 — Unknown UUID returns 404 from the chi router via the
// registered API handler (not the SPA fallback). Body shape is the
// api.Error envelope: {"code":"not_found","message":"..."}.
func TestApp_UnknownUUIDReturns404(t *testing.T) {
	a, _ := newTestApp(t)
	ts := httptest.NewServer(a.Handler())
	defer ts.Close()

	random := uuid.New()
	resp, err := http.Get(ts.URL + "/api/v1/notes/" + random.String())
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status: got %d, want 404", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	var got struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "not_found" {
		t.Errorf("code: got %q, want not_found", got.Code)
	}
}
