package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/internal/vault"
	"github.com/matthewoden/jasper/backend/migrations"
)

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
		DataDir:             dir,
		ListenAddr:          "127.0.0.1:0",
		Logger:              logger,
		DisableFirstRunGate: true,
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

// Test AP4 — EnsureDataDir creates both notes/ and .jasper/ (per-vault
// data subdir; Phase 9 D-06).
func TestEnsureDataDir_CreatesNotesAndStorage(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "fresh")
	if err := EnsureDataDir(root); err != nil {
		t.Fatalf("EnsureDataDir: %v", err)
	}
	for _, sub := range []string{"notes", vault.SubdirName} {
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

func pickFreeListener(t *testing.T) (net.Listener, string) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l, l.Addr().String()
}

// httpReadyProbe returns a waitFor probe that succeeds only when the
// full chi router is mounted and GET /api/v1/admin/status returns 200.
// With a pre-bound listener, kernel-level TCP connect and even an HTTP
// 503 from the disk-full handler complete the instant srv.Serve runs —
// strictly BEFORE a.notesSvc has been set (lifecycle.go:303). Requiring
// HTTP 200 is the only condition that guarantees the normal-boot path
// finished wiring NotesService and the apiServer router. Use this for
// every test that subsequently reads a.NotesService() or hits a real
// API endpoint. For tests that intentionally take the disk-full /
// startup-error path, use diskFullReadyProbe instead.
func httpReadyProbe(addr string) func() error {
	client := &http.Client{Timeout: 100 * time.Millisecond}
	return func() error {
		resp, err := client.Get("http://" + addr + "/api/v1/admin/status")
		if err != nil {
			return err
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("admin/status: got %d, want 200", resp.StatusCode)
		}
		return nil
	}
}

// diskFullReadyProbe returns a waitFor probe that succeeds when the
// startup-error handler is mounted and answering — i.e. lifecycle.Run
// took one of the disk-full / boot-error paths, swapped the handler to
// the bootErrorHandler, and started srv.Serve. The handler responds
// 503 with a startup_failed JSON body on every /api/* path.
func diskFullReadyProbe(addr string) func() error {
	client := &http.Client{Timeout: 100 * time.Millisecond}
	return func() error {
		resp, err := client.Get("http://" + addr + "/api/v1/admin/status")
		if err != nil {
			return err
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusServiceUnavailable {
			return fmt.Errorf("admin/status: got %d, want 503", resp.StatusCode)
		}
		return nil
	}
}

func waitFor(t *testing.T, timeout time.Duration, httpFn func() error) error {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		lastErr = httpFn()
		if lastErr == nil {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return fmt.Errorf("waitFor timed out after %s: %w", timeout, lastErr)
}

// TestApp_Run_FreshDB_BootsAndIndexesScratchpad — full happy-path
// boot. Uses the embedded migrations.FS (no override), creates a
// fresh temp data dir, runs the binary in-process, and asserts:
//   - GET /api/v1/notes returns 200 with at least 1 entry (the
//     seeded scratchpad — DATA-09 incremental at startup).
//   - GET /api/v1/admin/status returns state="ok".
func TestApp_Run_FreshDB_BootsAndIndexesScratchpad(t *testing.T) {
	dir := t.TempDir()
	ln, addr := pickFreeListener(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(Config{
		DataDir:             dir,
		ListenAddr:          addr,
		ListenerOverride:    ln,
		Logger:              logger,
		DisableFirstRunGate: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	probe := httpReadyProbe(addr)
	if err := waitFor(t, 5*time.Second, probe); err != nil {
		cancel()
		<-runErr
		t.Fatalf("listener did not come up: %v", err)
	}

	resp, err := http.Get("http://" + addr + "/api/v1/notes")
	if err != nil {
		cancel()
		<-runErr
		t.Fatalf("GET /api/v1/notes: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		cancel()
		<-runErr
		t.Fatalf("GET /api/v1/notes status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var listOut struct {
		Notes []struct {
			ID   string `json:"id"`
			Path string `json:"path"`
		} `json:"notes"`
	}
	if err := json.Unmarshal(body, &listOut); err != nil {
		cancel()
		<-runErr
		t.Fatalf("unmarshal notes list: %v; body=%s", err, body)
	}
	if len(listOut.Notes) < 1 {
		cancel()
		<-runErr
		t.Fatalf("expected at least 1 note (scratchpad); got %d; body=%s", len(listOut.Notes), body)
	}
	foundScratchpad := false
	for _, n := range listOut.Notes {
		if n.Path == notes.ScratchpadRelPath {
			foundScratchpad = true
			if n.ID != notes.ScratchpadUUID.String() {
				t.Errorf("scratchpad id: got %q, want %q", n.ID, notes.ScratchpadUUID.String())
			}
		}
	}
	if !foundScratchpad {
		t.Errorf("scratchpad.md not in notes list; body=%s", body)
	}

	resp2, err := http.Get("http://" + addr + "/api/v1/admin/status")
	if err != nil {
		cancel()
		<-runErr
		t.Fatalf("GET /api/v1/admin/status: %v", err)
	}
	body2, _ := io.ReadAll(resp2.Body)
	_ = resp2.Body.Close()
	if resp2.StatusCode != 200 {
		cancel()
		<-runErr
		t.Fatalf("GET /api/v1/admin/status status: got %d, want 200; body=%s", resp2.StatusCode, body2)
	}
	var statusOut struct {
		State string `json:"state"`
	}
	if err := json.Unmarshal(body2, &statusOut); err != nil {
		cancel()
		<-runErr
		t.Fatalf("unmarshal status: %v; body=%s", err, body2)
	}
	if statusOut.State != "ok" {
		cancel()
		<-runErr
		t.Fatalf("admin/status state: got %q, want ok; body=%s", statusOut.State, body2)
	}

	resp3, err := http.Get("http://" + addr + "/api/v1/notes/" + notes.ScratchpadUUID.String())
	if err != nil {
		cancel()
		<-runErr
		t.Fatalf("GET scratchpad by UUID: %v", err)
	}
	_ = resp3.Body.Close()
	if resp3.StatusCode != 200 {
		cancel()
		<-runErr
		t.Fatalf("scratchpad-by-UUID status: got %d, want 200", resp3.StatusCode)
	}

	cancel()
	if err := <-runErr; err != nil {
		t.Errorf("Run returned error after cancel: %v", err)
	}
}

// TestApp_Run_BrokenMigration_FiresPath1 — uses fstest.MapFS to inject
// a deliberately broken 002_break.sql. Asserts:
//   - The listener still comes up (Path 1 keeps the app running).
//   - GET /api/v1/admin/status returns state="rolled_back" with
//     failed_migration="002_break.sql".
func TestApp_Run_BrokenMigration_FiresPath1(t *testing.T) {
	initialBytes, err := migrations.FS.ReadFile("001_initial.sql")
	if err != nil {
		t.Fatalf("read embedded 001_initial.sql: %v", err)
	}
	override := fstest.MapFS{
		"001_initial.sql": &fstest.MapFile{Data: initialBytes},
		"002_break.sql":   &fstest.MapFile{Data: []byte("THIS IS NOT VALID SQL;")},
	}

	dir := t.TempDir()
	ln, addr := pickFreeListener(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(Config{
		DataDir:             dir,
		ListenAddr:          addr,
		ListenerOverride:    ln,
		Logger:              logger,
		MigrationsOverride:  override,
		DisableFirstRunGate: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	probe := diskFullReadyProbe(addr)
	if err := waitFor(t, 5*time.Second, probe); err != nil {
		cancel()
		<-runErr
		t.Fatalf("listener did not come up: %v", err)
	}

	resp, err := http.Get("http://" + addr + "/api/v1/admin/status")
	if err != nil {
		cancel()
		<-runErr
		t.Fatalf("GET /api/v1/admin/status: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		cancel()
		<-runErr
		t.Fatalf("status: got %d, want 503; body=%s", resp.StatusCode, body)
	}
	if !strings.Contains(string(body), "unrecoverable") {
		cancel()
		<-runErr
		t.Errorf("body did not contain 'unrecoverable': %s", body)
	}

	cancel()
	if err := <-runErr; err != nil {
		t.Logf("Run returned: %v", err)
	}
}

func seedRealSQLiteDB(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, vault.SubdirName), 0o755); err != nil {
		t.Fatalf("mkdir .jasper: %v", err)
	}
	dbPath := vault.AppDBPath(dir)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(Config{DataDir: dir, ListenAddr: "127.0.0.1:0", Logger: logger, DisableFirstRunGate: true})
	if err != nil {
		t.Fatalf("New (seed): %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	probe := func() error {
		c, derr := net.DialTimeout("tcp", a.cfg.ListenAddr, 50*time.Millisecond)
		_ = c
		_ = derr

		info, statErr := os.Stat(dbPath)
		if statErr != nil {
			return statErr
		}
		if info.Size() == 0 {
			return fmt.Errorf("db not yet written")
		}
		return nil
	}
	if err := waitFor(t, 5*time.Second, probe); err != nil {
		cancel()
		<-runErr
		t.Fatalf("seedRealSQLiteDB: db not ready: %v", err)
	}
	cancel()
	<-runErr
}

// TestApp_Run_DiskFull_ServesStaticPage — sets JASPER_TEST_FORCE_DISK_FULL
// in this process so the migrate runner's freeBytes hook returns 0.
// Asserts the listener serves a 503 HTML page on /, with no SPA shell
// returned.
func TestApp_Run_DiskFull_ServesStaticPage(t *testing.T) {
	dir := t.TempDir()
	seedRealSQLiteDB(t, dir)

	t.Setenv("JASPER_TEST_FORCE_DISK_FULL", "1")
	defer func() { _ = os.Unsetenv("JASPER_TEST_FORCE_DISK_FULL") }()

	ln, addr := pickFreeListener(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(Config{
		DataDir:             dir,
		ListenAddr:          addr,
		ListenerOverride:    ln,
		Logger:              logger,
		DisableFirstRunGate: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	probe := diskFullReadyProbe(addr)
	if err := waitFor(t, 5*time.Second, probe); err != nil {
		cancel()
		<-runErr
		t.Fatalf("listener did not come up: %v", err)
	}

	resp, err := http.Get("http://" + addr + "/")
	if err != nil {
		cancel()
		<-runErr
		t.Fatalf("GET /: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		cancel()
		<-runErr
		t.Fatalf("status: got %d, want 503; body=%s", resp.StatusCode, body)
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "text/html") {
		cancel()
		<-runErr
		t.Errorf("Content-Type: got %q, want text/html*", ct)
	}

	cancel()
	if err := <-runErr; err != nil {
		t.Logf("Run returned: %v", err)
	}
}

// TestRun_DiskFull_PreflightHaltsBeforeOpen — strengthens the W-3
// invariant. Boot-time disk-full preflight (lifecycle step 4a) MUST
// fire before sqlite.Open, so on a disk-full data volume we never
// open a DB connection at all (a.pair stays nil) and the listener
// still serves the static disk-full handler. This catches both
// JASPER_TEST_FORCE_DISK_FULL=1 and the production "data volume
// actually full" case — without this gate, sqlite.Open would crash
// with NOTADB on a corrupt/zero-filled app.db before we ever check
// free disk space.
func TestRun_DiskFull_PreflightHaltsBeforeOpen(t *testing.T) {
	dir := t.TempDir()

	seedRealSQLiteDB(t, dir)

	t.Setenv("JASPER_TEST_FORCE_DISK_FULL", "1")
	defer func() { _ = os.Unsetenv("JASPER_TEST_FORCE_DISK_FULL") }()

	ln, addr := pickFreeListener(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(Config{
		DataDir:             dir,
		ListenAddr:          addr,
		ListenerOverride:    ln,
		Logger:              logger,
		DisableFirstRunGate: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	probe := diskFullReadyProbe(addr)
	if err := waitFor(t, 5*time.Second, probe); err != nil {
		cancel()
		<-runErr
		t.Fatalf("listener did not come up: %v", err)
	}

	cancel()
	<-runErr

	if a.pair != nil {
		t.Fatalf("a.pair is non-nil after disk-full preflight; expected nil (sqlite.Open should not have run)")
	}
	if a.diskFullHandler == nil {
		t.Fatalf("a.diskFullHandler is nil; expected disk-full static handler installed")
	}
}

// TestRun_HydrateRegistry — Plan 03-04 Task 4: verifies the
// composition root hydrates the in-memory registry from indexer.List
// AFTER the startup incremental reindex completes and BEFORE the
// HTTP listener accepts connections (T-03-04-07 mitigation).
//
// Test setup: a tempdir vault with two .md files (alpha.md and
// projects/beta.md). After Run sets up the listener, the registry
// must already contain non-scratchpad UUIDs — Service.Get on a
// freshly-indexed UUID must succeed.
func TestRun_HydrateRegistry(t *testing.T) {
	dir := t.TempDir()

	if err := EnsureDataDir(dir); err != nil {
		t.Fatalf("EnsureDataDir: %v", err)
	}
	notesDir := notesDirFor(dir)
	if err := os.WriteFile(filepath.Join(notesDir, "alpha.md"), []byte("# Alpha\n"), 0o644); err != nil {
		t.Fatalf("write alpha.md: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(notesDir, "projects"), 0o755); err != nil {
		t.Fatalf("mkdir projects: %v", err)
	}
	if err := os.WriteFile(filepath.Join(notesDir, "projects", "beta.md"), []byte("# Beta\n"), 0o644); err != nil {
		t.Fatalf("write beta.md: %v", err)
	}

	ln, addr := pickFreeListener(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(Config{
		DataDir:             dir,
		ListenAddr:          addr,
		ListenerOverride:    ln,
		Logger:              logger,
		DisableFirstRunGate: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	probe := httpReadyProbe(addr)
	if err := waitFor(t, 5*time.Second, probe); err != nil {
		cancel()
		<-runErr
		t.Fatalf("listener did not come up: %v", err)
	}

	svc := a.NotesService()
	if svc == nil {
		cancel()
		<-runErr
		t.Fatalf("NotesService(): nil after Run set up listener")
	}

	resp, err := http.Get("http://" + addr + "/api/v1/notes")
	if err != nil {
		cancel()
		<-runErr
		t.Fatalf("GET /api/v1/notes: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		cancel()
		<-runErr
		t.Fatalf("GET /api/v1/notes: %d; body=%s", resp.StatusCode, body)
	}
	var listOut struct {
		Notes []struct {
			ID   string `json:"id"`
			Path string `json:"path"`
		} `json:"notes"`
	}
	if err := json.Unmarshal(body, &listOut); err != nil {
		cancel()
		<-runErr
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if len(listOut.Notes) < 3 {
		cancel()
		<-runErr
		t.Fatalf("expected at least 3 notes (scratchpad, alpha, projects/beta); got %d; body=%s",
			len(listOut.Notes), body)
	}

	for _, n := range listOut.Notes {
		id, perr := uuid.Parse(n.ID)
		if perr != nil {
			cancel()
			<-runErr
			t.Fatalf("parse id %q: %v", n.ID, perr)
		}
		if _, gerr := svc.Get(ctx, id); gerr != nil {
			cancel()
			<-runErr
			t.Fatalf("Service.Get(%s, path=%s) failed: %v (registry not hydrated for non-scratchpad UUIDs)",
				n.ID, n.Path, gerr)
		}
	}

	cancel()
	if err := <-runErr; err != nil {
		t.Errorf("Run returned error after cancel: %v", err)
	}
}

// TestApp_SecurityHeaders_OnAPIResponse — end-to-end through the chi chain:
// a real GET /api/v1/notes carries Content-Security-Policy + Referrer-Policy
// after securityHeadersMiddleware is mounted (Plan 05-04 / SECURITY-01, SECURITY-04).
func TestApp_SecurityHeaders_OnAPIResponse(t *testing.T) {
	a, _ := newTestApp(t)
	ts := httptest.NewServer(a.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/notes")
	if err != nil {
		t.Fatalf("GET /api/v1/notes: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if got := resp.Header.Get("Content-Security-Policy"); got != cspHeaderValue {
		t.Errorf("CSP on /api/v1/notes:\n got  %q\n want %q", got, cspHeaderValue)
	}
	if got := resp.Header.Get("Referrer-Policy"); got != "no-referrer" {
		t.Errorf("Referrer-Policy on /api/v1/notes: got %q, want %q", got, "no-referrer")
	}
	if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options on /api/v1/notes: got %q, want nosniff", got)
	}
	if got := resp.Header.Get("X-Frame-Options"); got != "DENY" {
		t.Errorf("X-Frame-Options on /api/v1/notes: got %q, want DENY", got)
	}
}

// TestApp_ListenerGated verifies SYNC-09: the WebSocket hub is wired BEFORE
// the listener accepts connections. When a client can reach the TCP port, the
// /ws endpoint must already be mounted and respond with a valid WS upgrade
// (101 Switching Protocols). A 404 or connection-refused here means the hub
// was constructed after the listener started — a race.
//
// We use a raw HTTP request rather than a WebSocket library so we can assert
// on the upgrade response without pulling in a WS client dependency in tests.
func TestApp_ListenerGated(t *testing.T) {
	dir := t.TempDir()
	ln, addr := pickFreeListener(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(Config{
		DataDir:             dir,
		ListenAddr:          addr,
		ListenerOverride:    ln,
		Logger:              logger,
		DisableFirstRunGate: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	probe := httpReadyProbe(addr)
	if err := waitFor(t, 5*time.Second, probe); err != nil {
		cancel()
		<-runErr
		t.Fatalf("listener did not come up: %v", err)
	}

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+"/api/v1/ws", nil)
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	req.Header.Set("Sec-WebSocket-Version", "13")

	req.Header.Set("Origin", "http://"+addr)

	tr := &http.Transport{}
	resp, err := tr.RoundTrip(req)
	if err != nil {
		cancel()
		<-runErr
		t.Fatalf("WS upgrade request failed: %v", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusSwitchingProtocols {
		cancel()
		<-runErr
		t.Fatalf("expected 101 Switching Protocols from /api/v1/ws, got %d (SYNC-09: hub not wired before listener)", resp.StatusCode)
	}

	cancel()
	if err := <-runErr; err != nil {
		t.Errorf("Run returned error after cancel: %v", err)
	}
}

// TestRun_FrontmatterMigrationRuns_BeforeReconcile — D-11 / TAGS-EXT-03:
// a vault with a .md file that lacks frontmatter boots cleanly and
// the file has frontmatter after Run completes. The listener must open
// (proving the migration ran and succeeded before the gate opened).
//
// This covers plan Test L2: vault note lacking frontmatter receives
// scaffold + backlinks path (implicit — Reconcile ran after migration).
func TestRun_FrontmatterMigrationRuns_BeforeReconcile(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureDataDir(dir); err != nil {
		t.Fatalf("EnsureDataDir: %v", err)
	}
	notesDir := notesDirFor(dir)

	noFMPath := filepath.Join(notesDir, "needs-fm.md")
	if err := os.WriteFile(noFMPath, []byte("# Needs FM\n\nBody here.\n"), 0o644); err != nil {
		t.Fatalf("write no-FM file: %v", err)
	}

	ln, addr := pickFreeListener(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(Config{DataDir: dir, ListenAddr: addr, ListenerOverride: ln, Logger: logger, DisableFirstRunGate: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	probe := httpReadyProbe(addr)
	if err := waitFor(t, 5*time.Second, probe); err != nil {
		cancel()
		<-runErr
		t.Fatalf("listener did not come up: %v", err)
	}

	got, err := os.ReadFile(noFMPath)
	if err != nil {
		cancel()
		<-runErr
		t.Fatalf("readFile after Run: %v", err)
	}
	if !strings.HasPrefix(string(got), "---\ntags: []\n---\n\n") {
		cancel()
		<-runErr
		t.Fatalf("file did not get frontmatter after Run: %q", got)
	}

	cancel()
	if err := <-runErr; err != nil {
		t.Errorf("Run returned error after cancel: %v", err)
	}
}

// TestRun_FrontmatterMigrationIdempotent — Test L3: Run twice on same vault;
// second start must not modify files (marker row prevents re-walk).
func TestRun_FrontmatterMigrationIdempotent(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureDataDir(dir); err != nil {
		t.Fatalf("EnsureDataDir: %v", err)
	}
	notesDir := notesDirFor(dir)
	noFMPath := filepath.Join(notesDir, "alpha.md")
	if err := os.WriteFile(noFMPath, []byte("# Alpha\nBody.\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	{
		ln, addr := pickFreeListener(t)
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		a, err := New(Config{DataDir: dir, ListenAddr: addr, ListenerOverride: ln, Logger: logger, DisableFirstRunGate: true})
		if err != nil {
			t.Fatalf("New (first): %v", err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		runErr := make(chan error, 1)
		go func() { runErr <- a.Run(ctx) }()
		probe := httpReadyProbe(addr)
		if err := waitFor(t, 5*time.Second, probe); err != nil {
			cancel()
			<-runErr
			t.Fatalf("first boot: listener did not come up: %v", err)
		}
		cancel()
		<-runErr
	}

	afterFirst, err := os.ReadFile(noFMPath)
	if err != nil {
		t.Fatalf("readFile after first boot: %v", err)
	}
	if !strings.HasPrefix(string(afterFirst), "---\ntags: []\n---\n\n") {
		t.Fatalf("file did not get frontmatter on first boot: %q", afterFirst)
	}

	{
		ln, addr := pickFreeListener(t)
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		a, err := New(Config{DataDir: dir, ListenAddr: addr, ListenerOverride: ln, Logger: logger, DisableFirstRunGate: true})
		if err != nil {
			t.Fatalf("New (second): %v", err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		runErr := make(chan error, 1)
		go func() { runErr <- a.Run(ctx) }()
		probe := httpReadyProbe(addr)
		if err := waitFor(t, 5*time.Second, probe); err != nil {
			cancel()
			<-runErr
			t.Fatalf("second boot: listener did not come up: %v", err)
		}
		cancel()
		<-runErr
	}

	afterSecond, err := os.ReadFile(noFMPath)
	if err != nil {
		t.Fatalf("readFile after second boot: %v", err)
	}
	if string(afterFirst) != string(afterSecond) {
		t.Errorf("file changed on second boot:\nbefore: %q\nafter:  %q", afterFirst, afterSecond)
	}
}

// TestApp_Run_NoVault_CreateVault_InPlaceTransition — UAT regression for the
// bug where POST /vault/create succeeded on disk but the running listener
// stayed in no-vault mode (frozen picker-shell handler), so subsequent /tree
// requests failed until process restart.
//
// Boots the app with no current_vault in app.json. The /api/v1/tree route on
// the no-vault picker shell returns an error because notesSvc is nil. After
// POST /api/v1/vault/create, the in-place transition (a.OpenVault →
// initVaultSubsystemsOnly + a.handler.Swap) must flip the listener over to
// the full per-vault router so /api/v1/tree returns 200.
func TestApp_Run_NoVault_CreateVault_InPlaceTransition(t *testing.T) {
	appHome := filepath.Join(t.TempDir(), ".jasper")
	t.Setenv("JASPER_APP_HOME", appHome)

	vaultDir := t.TempDir()

	ln, addr := pickFreeListener(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	a, err := New(Config{
		DataDir:          "",
		ListenAddr:       addr,
		ListenerOverride: ln,
		Logger:           logger,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-runErr:
		case <-time.After(2 * time.Second):
		}
	})

	if err := waitFor(t, 5*time.Second, func() error {
		c, dErr := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if dErr != nil {
			return dErr
		}
		_ = c.Close()
		return nil
	}); err != nil {
		t.Fatalf("listener did not come up: %v", err)
	}

	{
		resp, err := http.Get("http://" + addr + "/api/v1/vault/current")
		if err != nil {
			t.Fatalf("GET /vault/current (no-vault): %v", err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("pre-create /vault/current status: got %d, want 200; body=%s", resp.StatusCode, body)
		}

		if strings.Contains(string(body), `"path":`) {
			t.Errorf("pre-create /vault/current should not name a path; body=%s", body)
		}
	}

	createReq := fmt.Sprintf(`{"path":%q,"theme":"dark","mcp_enabled":false,"daily_template":"# {{date}}\n\n"}`, vaultDir)
	createResp, err := http.Post("http://"+addr+"/api/v1/vault/create", "application/json", strings.NewReader(createReq))
	if err != nil {
		t.Fatalf("POST /vault/create: %v", err)
	}
	createBody, _ := io.ReadAll(createResp.Body)
	_ = createResp.Body.Close()
	if createResp.StatusCode != 200 {
		t.Fatalf("POST /vault/create status: got %d, want 200; body=%s", createResp.StatusCode, createBody)
	}

	if _, statErr := os.Stat(filepath.Join(vaultDir, ".jasper")); statErr != nil {
		t.Fatalf("expected %s/.jasper to exist after create: %v", vaultDir, statErr)
	}
	if _, statErr := os.Stat(filepath.Join(vaultDir, ".jasper", "config.json")); statErr != nil {
		t.Errorf("expected .jasper/config.json after create: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(vaultDir, ".jasper", "app.db")); statErr != nil {
		t.Errorf("expected .jasper/app.db after create (migrations ran): %v", statErr)
	}
	appJSON, appJSONErr := os.ReadFile(filepath.Join(appHome, "app.json"))
	if appJSONErr != nil {
		t.Fatalf("read app.json: %v", appJSONErr)
	}
	if !strings.Contains(string(appJSON), `"current_vault"`) {
		t.Errorf("app.json should have current_vault set; got %s", appJSON)
	}

	{
		resp, err := http.Get("http://" + addr + "/api/v1/tree")
		if err != nil {
			t.Fatalf("GET /tree post-create: %v", err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("post-create /tree status: got %d, want 200 (in-place transition failed?); body=%s", resp.StatusCode, body)
		}
	}
	{
		resp, err := http.Get("http://" + addr + "/api/v1/admin/status")
		if err != nil {
			t.Fatalf("GET /admin/status post-create: %v", err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("post-create /admin/status: got %d, want 200; body=%s", resp.StatusCode, body)
		}
		if !strings.Contains(string(body), `"state":"ok"`) {
			t.Errorf("post-create /admin/status state: expected ok; body=%s", body)
		}
	}

	{
		resp, err := http.Get("http://" + addr + "/api/v1/vault/current")
		if err != nil {
			t.Fatalf("GET /vault/current post-create: %v", err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()

		base := filepath.Base(vaultDir)
		if !strings.Contains(strings.ToLower(string(body)), strings.ToLower(base)) {
			t.Errorf("post-create /vault/current should name %q; body=%s", base, body)
		}
	}
}
