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

const defaultListenAddr = "127.0.0.1:6683"

const envMigrationsOverride = "JASPER_TEST_MIGRATIONS_DIR"

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

	DisableFlagParsing: true,
	RunE: func(_ *cobra.Command, args []string) error {
		return runServe(args)
	},
}

func init() {
	rootCmd.AddCommand(serveCmd)
}

var serveLog = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

func setServeLogForTest(t interface{ Cleanup(func()) }, l *slog.Logger) {
	orig := serveLog
	serveLog = l
	t.Cleanup(func() { serveLog = orig })
}

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	addrFlag := fs.String("addr", defaultListenAddr,
		"Listen address (loopback-only by default). Dev pipeline reads the same port from scripts/port.sh.")

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

	if err := netbind.RequireLoopbackBind(*addrFlag); err != nil {
		return err
	}

	cfg := app.Config{
		DataDir:       absVault,
		Server:        config.ServerConfig{Port: 6683, DataDir: absVault},
		ListenAddr:    *addrFlag,
		Logger:        log,
		VaultOverride: absVault,
	}

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

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return a.Run(ctx)
}
