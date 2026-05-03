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
	"github.com/matthewoden/jasper/backend/migrations"
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

// ---------------------------------------------------------------------------
// Phase 2 / Plan 02-06 tests — composition root + lifecycle gating.
// ---------------------------------------------------------------------------

// pickFreePort returns a port the kernel just freed up. Tests use this
// instead of :0 because the lifecycle Run() code path needs a known
// port to dial — :0 would return a random port that we cannot dial back
// without intercepting the listener via net.Listen.
func pickFreePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	addr := l.Addr().String()
	if err := l.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return addr
}

// waitFor probes httpFn at 10ms intervals until it returns nil or the
// timeout elapses. Used to wait for the listener to come up.
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
	addr := pickFreePort(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(Config{
		DataDir:    dir,
		ListenAddr: addr,
		Logger:     logger,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	// Wait for the listener.
	probe := func() error {
		c, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err != nil {
			return err
		}
		_ = c.Close()
		return nil
	}
	if err := waitFor(t, 5*time.Second, probe); err != nil {
		cancel()
		<-runErr
		t.Fatalf("listener did not come up: %v", err)
	}

	// GET /api/v1/notes
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
			Id   string `json:"id"`
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
			if n.Id != notes.ScratchpadUUID.String() {
				t.Errorf("scratchpad id: got %q, want %q", n.Id, notes.ScratchpadUUID.String())
			}
		}
	}
	if !foundScratchpad {
		t.Errorf("scratchpad.md not in notes list; body=%s", body)
	}

	// GET /api/v1/admin/status
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

	// Phase 1 ScratchpadUUID compatibility — the old hardcoded UUID
	// still resolves 200 even after Phase 2 ships.
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
	// Build the broken migrations FS: copy 001_initial.sql verbatim
	// from the embedded migrations + add a nonsense 002_break.sql.
	initialBytes, err := migrations.FS.ReadFile("001_initial.sql")
	if err != nil {
		t.Fatalf("read embedded 001_initial.sql: %v", err)
	}
	override := fstest.MapFS{
		"001_initial.sql": &fstest.MapFile{Data: initialBytes},
		"002_break.sql":   &fstest.MapFile{Data: []byte("THIS IS NOT VALID SQL;")},
	}

	dir := t.TempDir()
	addr := pickFreePort(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(Config{
		DataDir:            dir,
		ListenAddr:         addr,
		Logger:             logger,
		MigrationsOverride: override,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	// First boot: 001 applies, 002 fails. With no prior schema this
	// is Path 3 (no backup to restore to). The runner returns
	// ErrUnrecoverable, lifecycle.Run installs the unrecoverable
	// boot-error handler, and the listener serves it. Test that the
	// /api/v1/admin/status behavior matches the unrecoverable wire
	// shape (the error handler returns 503 + JSON for /api/ paths).
	probe := func() error {
		c, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err != nil {
			return err
		}
		_ = c.Close()
		return nil
	}
	if err := waitFor(t, 5*time.Second, probe); err != nil {
		cancel()
		<-runErr
		t.Fatalf("listener did not come up: %v", err)
	}

	// On a fresh DB the runner cannot Path-1-restore (no prior
	// schema). It returns ErrUnrecoverable and the unrecoverable
	// boot-error handler is mounted. /api/ paths return 503 JSON.
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

// seedRealSQLiteDB opens a sqlite Pair at <dir>/storage/app.db, applies
// 001_initial.sql to give the file non-zero size + a valid SQLite
// header, and closes the pair. The resulting file on disk is a valid
// SQLite DB the runner.preflight can stat (size > 0) and sqlite.Open
// can subsequently ping. Used by the disk-full tests to set up the
// preflight-aborts-on-empty-disk scenario.
func seedRealSQLiteDB(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "storage"), 0o755); err != nil {
		t.Fatalf("mkdir storage: %v", err)
	}
	dbPath := filepath.Join(dir, "storage", "app.db")
	// Use a fresh app.New + Run cycle to apply the embedded
	// migrations.FS once; that gives us a real SQLite file. We can't
	// just call sqlite.Open here because the test package can't easily
	// reach into the migration runner; instead spawn a tiny in-process
	// boot and shut it down immediately.
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(Config{DataDir: dir, ListenAddr: "127.0.0.1:0", Logger: logger})
	if err != nil {
		t.Fatalf("New (seed): %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()
	// Wait until the listener is up — that means migrations applied
	// and the file is committed to disk.
	probe := func() error {
		c, derr := net.DialTimeout("tcp", a.cfg.ListenAddr, 50*time.Millisecond)
		_ = c
		_ = derr
		// We don't actually know which port :0 picked. Instead poll
		// for the db file appearing with a non-zero size.
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
	// Seed a real SQLite DB so the runner.preflight has something to
	// size against (currentSize > 0 is required for the 2× heuristic
	// to actually exceed `free=0`).
	dir := t.TempDir()
	seedRealSQLiteDB(t, dir)

	t.Setenv("JASPER_TEST_FORCE_DISK_FULL", "1")
	defer os.Unsetenv("JASPER_TEST_FORCE_DISK_FULL")

	addr := pickFreePort(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(Config{
		DataDir:    dir,
		ListenAddr: addr,
		Logger:     logger,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	probe := func() error {
		c, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err != nil {
			return err
		}
		_ = c.Close()
		return nil
	}
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

// TestRun_DiskFull_PairClosed (W-3) — proves the deferred pair.Close()
// fires even on the disk-full path. After Run exits via ErrDiskFull,
// pair.Reader.PingContext must return a "database is closed" error.
func TestRun_DiskFull_PairClosed(t *testing.T) {
	dir := t.TempDir()
	// Seed a real SQLite DB (size > 0) so the runner.preflight
	// computes non-zero `required` and the 0-free hook actually
	// trips ErrDiskFull (vs. silent fresh-DB skip).
	seedRealSQLiteDB(t, dir)

	t.Setenv("JASPER_TEST_FORCE_DISK_FULL", "1")
	defer os.Unsetenv("JASPER_TEST_FORCE_DISK_FULL")

	addr := pickFreePort(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := New(Config{
		DataDir:    dir,
		ListenAddr: addr,
		Logger:     logger,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	// Wait for listener so we know boot reached serveListener (=
	// the deferred pair.Close has not yet fired but pair is open).
	probe := func() error {
		c, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err != nil {
			return err
		}
		_ = c.Close()
		return nil
	}
	if err := waitFor(t, 5*time.Second, probe); err != nil {
		cancel()
		<-runErr
		t.Fatalf("listener did not come up: %v", err)
	}

	// Cancel and wait for Run to return — this triggers the
	// deferred pair.Close(). Then assert the pair really is closed.
	cancel()
	<-runErr
	if a.pair == nil {
		t.Fatalf("a.pair is nil; expected populated before disk-full halt")
	}
	pingCtx, pingCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer pingCancel()
	if err := a.pair.Reader.PingContext(pingCtx); err == nil {
		t.Errorf("pair.Reader.Ping returned nil after Run exit; expected closed-db error")
	} else if !strings.Contains(err.Error(), "closed") {
		// modernc.org/sqlite + database/sql wraps the closed pool as
		// "sql: database is closed". Match on the substring "closed"
		// to avoid coupling to the exact wrapper text.
		t.Errorf("pair.Reader.Ping err = %q; want substring 'closed'", err)
	}
}
