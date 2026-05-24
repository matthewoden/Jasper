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

	"github.com/spf13/cobra"

	"github.com/matthewoden/jasper/backend/internal/app"
	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/netbind"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

// defaultListenAddr is the production bind address — loopback only,
// port 6683 (T9 keypad spelling of "NOTE"). Phase 8 D-40 / D-41
// migrated the default from :3000 to :6683 to stop colliding with
// everyone-else's-dev-server.
//
// Dev pipeline (.air.toml + Vite proxy + Playwright) reads the same
// canonical port from scripts/port.sh so dev/prod stay in parity —
// scripts/port.sh returns server.port from ~/.jasper/storage/config.json
// or this default 6683 when no config exists.
//
// All bind paths flow through netbind.RequireLoopbackBind (Phase 8
// Plan 08-01 Task 3 moved the function out of this file into the
// shared backend/internal/netbind/ package so the MCP listener can
// reuse it without an import cycle).
const defaultListenAddr = "127.0.0.1:6683"

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

// serveCmd is the cobra wrapper around runServe. Plan 08-11 (D-34)
// migrated dispatch from stdlib flag to cobra; the underlying runServe
// signature `runServe(args []string) error` is preserved so existing
// callers (smoke_test.go) keep working.
//
// The serve flags (--data-dir, --addr) are kept on a flag.FlagSet
// inside runServe rather than promoted to cobra-native flags because:
//   - smoke_test.go and the broader integration test fleet drive
//     runServe directly with an args slice, not via rootCmd.Execute(),
//   - keeping the flag parsing inside runServe means one source of
//     truth for "what args does serve accept" and zero divergence
//     between the cobra path (production) and the direct-call path
//     (tests).
//
// The cobra command simply re-collects os.Args after the "serve"
// subcommand token and hands them to runServe.
var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the Jasper HTTP + WebSocket server",
	Long: `Start the Jasper server. Binds to 127.0.0.1:6683 by default (override
via --addr; dev mode reads the same port from scripts/port.sh so the
Vite proxy at :5173 forwards /api → the running backend).
Phase 8 enforces loopback binding via internal/netbind.

The data directory holds three subdirectories:
  notes/    — your .md files (the source of truth)
  storage/  — the SQLite index (regenerable from notes/)
  logs/     — jasper.log with daily rotation

Resolution order for --data-dir:
  1. --data-dir flag
  2. $JASPER_DATA_DIR environment variable
  3. ~/.jasper (default)

Examples:
  $ jasper serve                              # default loopback bind, default data dir
  $ jasper serve --data-dir /path/to/notes
  $ jasper serve --addr 127.0.0.1:6700        # custom port (must match config.json server.port)`,
	// DisableFlagParsing tells cobra to hand the raw args (after the
	// "serve" token) to RunE without intercepting --addr / --data-dir.
	// runServe's flag.FlagSet then parses them just like before.
	DisableFlagParsing: true,
	RunE: func(_ *cobra.Command, args []string) error {
		return runServe(args)
	},
}

func init() {
	rootCmd.AddCommand(serveCmd)
}

// serveLog is the logger used by runServe. It defaults to stderr text handler
// but is replaceable via setServeLogForTest for test-seam injection.
var serveLog = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

// setServeLogForTest replaces the package-level serveLog for the duration of
// the test and restores it afterward. Test-only; no production callers.
func setServeLogForTest(t interface{ Cleanup(func()) }, l *slog.Logger) {
	orig := serveLog
	serveLog = l
	t.Cleanup(func() { serveLog = orig })
}

// runServe parses flags, resolves the data directory per ADR-001
// precedence (--vault > --data-dir alias > JASPER_DATA_DIR alias > ~/.jasper),
// enforces the loopback bind rule, and runs app.Run until SIGINT/SIGTERM.
//
// --vault (ADR-001): canonical abs path to the vault; bypasses picker.
// --data-dir: deprecated alias for --vault (warns); will be removed pre-v1.0.
// JASPER_DATA_DIR: deprecated env alias for --vault (warns); retained for CI/tests.
func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	dataDirFlag := fs.String("data-dir", "", "Path to data directory (deprecated: use --vault per ADR-001)")
	addrFlag := fs.String("addr", defaultListenAddr,
		"Listen address (loopback-only by default). Dev pipeline reads the same port from scripts/port.sh.")
	if err := fs.Parse(args); err != nil {
		return err
	}

	log := serveLog

	// ADR-001 precedence:
	//   1. --vault <abs>       (CLI override; CI/E2E; bypasses picker)
	//   2. --data-dir          (DEPRECATED ALIAS — warns; back-compat until removed pre-v1.0)
	//   3. JASPER_DATA_DIR     (DEPRECATED ENV ALIAS — warns; retained for CI/tests)
	//   4. app.json current_vault (read by resolveVaultMode in lifecycle.Run)
	//
	// Plan 08-17b: --vault / --data-dir / JASPER_DATA_DIR are promoted to
	// cfg.VaultOverride (consumed by resolveVaultMode) instead of a local
	// dataDir variable. The local `dataDir` variable from 17a is fully
	// superseded; resolveVaultMode now reads cfg.VaultOverride directly.
	var legacyDataDir string
	switch {
	case vaultFlag != "":
		canonical, err := vault.Canonicalize(vaultFlag)
		if err != nil {
			return fmt.Errorf("invalid --vault path: %w", err)
		}
		// --vault populates VaultOverride to bypass app.json's current_vault.
		// legacyDataDir also set for the Config.DataDir backward-compat field.
		legacyDataDir = canonical
	case *dataDirFlag != "":
		log.Warn("--data-dir is deprecated; use --vault per ADR-001", "value", *dataDirFlag)
		legacyDataDir = *dataDirFlag
	case os.Getenv("JASPER_DATA_DIR") != "":
		log.Warn("JASPER_DATA_DIR is deprecated and retained as a hidden alias for tests/CI; use --vault per ADR-001")
		legacyDataDir = os.Getenv("JASPER_DATA_DIR")
	default:
		// No override: resolveVaultMode reads app.json's current_vault at boot.
		// legacyDataDir stays empty; lifecycle.Run will populate cfg.DataDir
		// once the vault is resolved.
		legacyDataDir = ""
	}
	absDataDir := legacyDataDir
	if legacyDataDir != "" {
		var err error
		absDataDir, err = filepath.Abs(legacyDataDir)
		if err != nil {
			return fmt.Errorf("resolve data-dir to absolute path: %w", err)
		}
	}

	// Bind-address gate — Phase 1 refuses non-loopback bind to enforce
	// SECURITY-05 default. Phase 8 will revisit for the WSL2 case where
	// 0.0.0.0 is required for Windows-host browser access; that decision
	// is deferred and the safe default lives here.
	if err := netbind.RequireLoopbackBind(*addrFlag); err != nil {
		return err
	}

	// Populate app.Config. Server.Port defaults to 6683 (D-50). VaultOverride
	// is set when --vault / --data-dir / JASPER_DATA_DIR points at a specific
	// vault path; resolveVaultMode in lifecycle.Run reads it to bypass
	// app.json's current_vault (ADR-001 §2). DataDir is set to the same
	// value for backward compatibility with code that reads cfg.DataDir.
	cfg := app.Config{
		DataDir:       absDataDir,
		Server:        config.ServerConfig{Port: 6683, DataDir: absDataDir},
		ListenAddr:    *addrFlag,
		Logger:        log,
		VaultOverride: absDataDir, // non-empty only when a flag/env was given
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
