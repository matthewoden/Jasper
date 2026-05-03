package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/matthewoden/jasper/backend/internal/app"
)

// defaultListenAddr is the production bind address — loopback only,
// port 3000 (the canonical Jasper port). Dev mode (.air.toml) passes
// --addr 127.0.0.1:3001 so the Vite proxy at :5173 can target :3001
// per CONTEXT.md D-13. Both pass requireLoopbackBind below.
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
	if err := requireLoopbackBind(*addrFlag); err != nil {
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

// requireLoopbackBind rejects bind addresses that are not localhost or
// 127.0.0.1 / ::1. Defense in depth: a coworker who copy-pastes
// 0.0.0.0:3000 from a tutorial does NOT accidentally expose Jasper to
// the LAN before Phase 8 properly handles the WSL2 case.
//
// Empty-host addresses (like ":3000") are also rejected because
// net.Listen treats them as 0.0.0.0 — i.e. all interfaces. A user
// who writes ":3000" probably means "127.0.0.1:3000"; surfacing the
// rejection forces them to make the binding explicit.
//
// The error string includes the literal "loopback" so the smoke test
// can grep for it.
func requireLoopbackBind(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid --addr %q: %w", addr, err)
	}
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return nil
	}
	// Reject anything else, including 0.0.0.0 and the empty host
	// shorthand (":3000") which net.Listen interprets as all-interfaces.
	return errors.New(
		"phase 1 only allows binding to loopback (localhost / 127.0.0.1 / ::1); " +
			"0.0.0.0 will be revisited in phase 8",
	)
}
