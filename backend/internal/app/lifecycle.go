package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// notesDirFor returns <dataDir>/notes — the source-of-truth directory
// per DESIGN.md §4.1. Centralized so app.New and lifecycle agree.
func notesDirFor(dataDir string) string { return filepath.Join(dataDir, "notes") }

// EnsureDataDir creates <dataDir>/{notes,storage} with 0o755 perms if
// missing. 0o755 (not 0o700) is intentional per CONTEXT.md / threat
// model T-01-04-07: Jasper runs as the user, the data dir lives under
// the user's home, and 0o755 matches the prevailing convention for
// app-data dirs on macOS / Linux. A more restrictive 0o700 default
// would surprise external sync tools (Syncthing, iCloud, git) that
// expect to walk the tree.
func EnsureDataDir(dataDir string) error {
	for _, sub := range []string{"notes", "storage"} {
		if err := os.MkdirAll(filepath.Join(dataDir, sub), 0o755); err != nil {
			return fmt.Errorf("ensure %s: %w", sub, err)
		}
	}
	return nil
}

// SeedScratchpadIfMissing writes notes.ScratchpadWelcome to
// <dataDir>/notes/scratchpad.md ONLY if the file does not already
// exist. Idempotent — safe to call on every startup. Per CONTEXT.md
// D-08 / UI-SPEC §Copywriting Contract.
//
// We use os.WriteFile here rather than fsstore.AtomicWrite because
// the seed is a single-shot operation with no concurrent writers,
// and pulling fsstore in here would create a lifecycle → fsstore
// dependency that the package layout deliberately avoids. The
// runtime save path (Service.Update → FileStore.WriteAtomic) uses
// fsstore.AtomicWrite per DATA-13.
func SeedScratchpadIfMissing(dataDir string, log *slog.Logger) error {
	path := filepath.Join(notesDirFor(dataDir), notes.ScratchpadRelPath)
	if _, err := os.Stat(path); err == nil {
		log.Info("scratchpad already exists; skipping seed", "path", path)
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("stat scratchpad: %w", err)
	}
	if err := os.WriteFile(path, []byte(notes.ScratchpadWelcome), 0o644); err != nil {
		return fmt.Errorf("seed scratchpad: %w", err)
	}
	log.Info("seeded scratchpad", "path", path, "bytes", len(notes.ScratchpadWelcome))
	return nil
}

// Run executes the full startup sequence and serves until ctx is
// canceled. On ctx cancellation a graceful shutdown is attempted
// with a 5-second deadline.
//
// Steps:
//
//  1. EnsureDataDir — mkdir <DataDir>/{notes,storage}.
//  2. SeedScratchpadIfMissing — write the welcome template if absent.
//  3. net.Listen("tcp", addr) — pre-bind so bind errors surface
//     BEFORE the "listening" log line (avoids a false positive in
//     a parent shell that greps for that line).
//  4. http.Server.Serve(listener) in a goroutine.
//  5. select on ctx.Done() vs goroutine error — graceful shutdown
//     on the former, propagate the error on the latter.
//
// ReadHeaderTimeout is set per threat model T-01-04-05 to mitigate
// slowloris-style attacks. Full ReadTimeout / WriteTimeout are
// deferred to Phase 4 alongside the WebSocket hub timeout config.
func (a *App) Run(ctx context.Context) error {
	// 1. Ensure data dir + notes/ + storage/ exist.
	if err := EnsureDataDir(a.cfg.DataDir); err != nil {
		return err
	}
	// 2. Seed scratchpad.md if missing.
	if err := SeedScratchpadIfMissing(a.cfg.DataDir, a.cfg.Logger); err != nil {
		return err
	}

	// 3. Construct http.Server.
	srv := &http.Server{
		Addr:              a.cfg.ListenAddr,
		Handler:           a.handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	// 4. Pre-bind to surface bind errors before the "listening" log.
	ln, err := net.Listen("tcp", a.cfg.ListenAddr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", a.cfg.ListenAddr, err)
	}
	a.cfg.Logger.Info("jasper listening", "addr", a.cfg.ListenAddr, "data_dir", a.cfg.DataDir)

	// 5. Serve until ctx cancellation, then graceful shutdown.
	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
