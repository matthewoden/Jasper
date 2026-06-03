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
// The serve flags (--vault, --addr) are kept on a flag.FlagSet
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

The vault directory holds:
  notes/    — your .md files (the source of truth)
  .jasper/  — per-vault SQLite index, config, app.db (regenerable from notes/)
  logs/     — jasper.log with daily rotation

Vault resolution order (ADR-001):
  1. --vault flag (absolute path; bypasses picker)
  2. current_vault in ~/.jasper/app.json
  3. picker UI served at /

Examples:
  $ jasper serve                              # default loopback bind; picker or app.json
  $ jasper serve --vault /path/to/vault       # bypass picker
  $ jasper serve --addr 127.0.0.1:6700        # custom port (must match config.json server.port)`,
	// DisableFlagParsing tells cobra to hand the raw args (after the
	// "serve" token) to RunE without intercepting --addr / --vault.
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

// runServe parses flags, resolves the vault per ADR-001 precedence
// (--vault > app.json current_vault > picker), enforces the loopback
// bind rule, and runs app.Run until SIGINT/SIGTERM.
//
// --vault (ADR-001): canonical abs path to the vault; bypasses picker.
// Plan 08-23 (R4-15): the deprecated --data-dir flag and JASPER_DATA_DIR
// env var aliases were removed. Greenfield posture (pre-v1.0) — no
// user-side migration needed because they were never in production use.
func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	addrFlag := fs.String("addr", defaultListenAddr,
		"Listen address (loopback-only by default). Dev pipeline reads the same port from scripts/port.sh.")
	// UAT-2 R4-1: --vault is declared as a root PersistentFlag (root.go), but
	// serveCmd has DisableFlagParsing=true so the persistent binding never
	// runs. Mirror the flag locally so `bin/jasper serve --vault <path>`
	// works alongside the legacy `bin/jasper --vault <path> serve` form.
	// The local value seeds the package-level vaultFlag that the resolution
	// switch below reads.
	vaultFlagLocal := fs.String("vault", "", "Path to vault (ADR-001; bypasses picker)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *vaultFlagLocal != "" {
		vaultFlag = *vaultFlagLocal
	}

	log := serveLog

	// ADR-001 precedence:
	//   1. --vault <abs>       (CLI override; CI/E2E; bypasses picker)
	//   2. app.json current_vault (read by resolveVaultMode in lifecycle.Run)
	//   3. picker UI at /
	//
	// Plan 08-17b: --vault is promoted to cfg.VaultOverride (consumed by
	// resolveVaultMode). Plan 08-23: --data-dir and JASPER_DATA_DIR were
	// the only other sources of cfg.VaultOverride; both removed.
	var vaultOverride string
	if vaultFlag != "" {
		canonical, err := vault.Canonicalize(vaultFlag)
		if err != nil {
			return fmt.Errorf("invalid --vault path: %w", err)
		}
		vaultOverride = canonical
	}
	absVault := vaultOverride
	if vaultOverride != "" {
		var err error
		absVault, err = filepath.Abs(vaultOverride)
		if err != nil {
			return fmt.Errorf("resolve vault path: %w", err)
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
	// is set when --vault points at a specific vault path; resolveVaultMode
	// in lifecycle.Run reads it to bypass app.json's current_vault (ADR-001 §2).
	// DataDir is set to the same value for backward compatibility with code
	// that reads cfg.DataDir.
	cfg := app.Config{
		DataDir:       absVault,
		Server:        config.ServerConfig{Port: 6683, DataDir: absVault},
		ListenAddr:    *addrFlag,
		Logger:        log,
		VaultOverride: absVault, // non-empty only when --vault was given
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
