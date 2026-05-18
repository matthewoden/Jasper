package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/matthewoden/jasper/backend/internal/app"
	"github.com/matthewoden/jasper/backend/internal/netbind"
)

// defaultListenAddr is the production bind address — loopback only,
// port 3000 (the canonical Jasper port). Dev mode (.air.toml) passes
// --addr 127.0.0.1:3001 so the Vite proxy at :5173 can target :3001
// per CONTEXT.md D-13. Both pass netbind.RequireLoopbackBind (Phase 8
// Plan 08-01 Task 3 moved the function out of this file into the
// shared backend/internal/netbind/ package so the MCP listener can
// reuse it without an import cycle).
const defaultListenAddr = "127.0.0.1:3000"

// envMigrationsOverride names the test-only environment variable that
// swaps the embedded migrations.FS for an on-disk directory tree. When
// set, runServe wires `os.DirFS(<value>)` into app.Config.MigrationsOverride
// and the migration runner reads its SQL files from there instead of
// the binary-embedded migrations/*.sql.
//
// Plan 02-06 / Task 3 introduces this hook so backend/cmd/jasper/smoke_test.go
// can drive the broken-migration / Path 1 / Path 2 scenarios end-to-end
// against the production binary without rebuilding the migrations FS.
//
// PRODUCTION USE IS UNSUPPORTED. The launchd plist and systemd unit
// shipped in Phase 8 do NOT set this variable. A WARN is logged at
// startup if the variable is set so that an accidental production
// deployment surfaces in the standard slog stream (T-02-06-01
// mitigation).
const envMigrationsOverride = "JASPER_TEST_MIGRATIONS_DIR"

// runServe parses flags, resolves the data directory per D-07
// precedence (flag > env > default), enforces the loopback bind rule,
// and runs app.Run until SIGINT/SIGTERM.
func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	dataDirFlag := fs.String("data-dir", "", "Path to data directory (default: $JASPER_DATA_DIR or ~/.jasper)")
	addrFlag := fs.String("addr", defaultListenAddr,
		"Listen address (Phase 1: loopback only). Dev passes 127.0.0.1:3001 via .air.toml.")
	if err := fs.Parse(args); err != nil {
		return err
	}

	// D-07 precedence: --data-dir flag > $JASPER_DATA_DIR env > ~/.jasper.
	dataDir := *dataDirFlag
	if dataDir == "" {
		dataDir = os.Getenv("JASPER_DATA_DIR")
	}
	if dataDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("resolve $HOME for default data-dir: %w", err)
		}
		dataDir = filepath.Join(home, ".jasper")
	}
	absDataDir, err := filepath.Abs(dataDir)
	if err != nil {
		return fmt.Errorf("resolve data-dir to absolute path: %w", err)
	}

	// Bind-address gate — Phase 1 refuses non-loopback bind to enforce
	// SECURITY-05 default. Phase 8 will revisit for the WSL2 case where
	// 0.0.0.0 is required for Windows-host browser access; that decision
	// is deferred and the safe default lives here.
	if err := netbind.RequireLoopbackBind(*addrFlag); err != nil {
		return err
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg := app.Config{
		DataDir:    absDataDir,
		ListenAddr: *addrFlag,
		Logger:     log,
	}

	// Test-only: JASPER_TEST_MIGRATIONS_DIR replaces the embedded
	// migrations.FS with os.DirFS(<dir>). Plan 02-06 / Task 3
	// smoke_test.go drives Path 1 and Path 2 by mutating the dir
	// between calls (e.g. removing 002_break.sql to flip from
	// rolled_back → ok on the next admin/reindex).
	if mDir := os.Getenv(envMigrationsOverride); mDir != "" {
		log.Warn(
			"JASPER_TEST_MIGRATIONS_DIR is set; swapping embedded migrations.FS for on-disk directory — TEST USE ONLY",
			"dir", mDir,
		)
		cfg.MigrationsOverride = os.DirFS(mDir)
	}

	a, err := app.New(cfg)
	if err != nil {
		return err
	}

	// Cancel on SIGINT/SIGTERM for graceful shutdown.
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return a.Run(ctx)
}

// requireLoopbackBind moved to backend/internal/netbind/ (Phase 8
// Plan 08-01 Task 3). Callers use netbind.RequireLoopbackBind.
