package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
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
via --bind; dev mode reads the same port from scripts/port.sh so the
Vite proxy at :5173 forwards /api → the running backend).
Non-loopback binds log a startup warning; MCP always stays loopback.

The vault directory holds:
  notes/    — your .md files (the source of truth)
  .jasper/  — per-vault SQLite index, config, app.db (regenerable from notes/)
  logs/     — jasper.log with daily rotation

Vault resolution order:
  1. --vault flag (absolute path; bypasses picker)
  2. current_vault in ~/.jasper/app.json
  3. picker UI served at /

Bind address precedence:
  1. --bind flag (when explicitly passed)
  2. server.bind in config.json
  3. 127.0.0.1:6683 (default)

Examples:
  $ jasper serve                              # default loopback bind; picker or app.json
  $ jasper serve --vault /path/to/vault       # bypass picker
  $ jasper serve --bind 0.0.0.0:6683          # expose on all interfaces (trusted networks only)
  $ jasper serve --bind 127.0.0.1:6700        # custom port (must match config.json server.port)`,

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

// resolveBindAddr determines the HTTP listen address from the config and the
// explicitly-set CLI flag value. Precedence: CLI --bind > config server.bind >
// defaultListenAddr.
//
// bindFlagValue is the raw value of --bind (empty string means not explicitly set).
// bindFlagExplicit is true when the user passed --bind on the command line.
func resolveBindAddr(cfg config.Config, bindFlagValue string, bindFlagExplicit bool) (string, error) {
	resolved := defaultListenAddr
	if cfg.Server.Bind != "" {
		resolved = cfg.Server.Bind + ":" + strconv.Itoa(cfg.Server.Port)
	}
	if bindFlagExplicit && bindFlagValue != "" {
		resolved = bindFlagValue
	}
	if _, _, err := net.SplitHostPort(resolved); err != nil {
		return "", fmt.Errorf("invalid --bind address %q: %w", resolved, err)
	}
	return resolved, nil
}

func runServe(args []string) error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return runServeContext(ctx, args)
}

// runServeContext is the body of runServe with the lifecycle context injected so
// tests can drive shutdown without raising an OS signal. Non-test callers go
// through runServe, which wires ctx to SIGINT/SIGTERM.
func runServeContext(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	// Empty default so flag.Visit can detect when --bind was explicitly passed.
	bindFlag := fs.String("bind", "",
		"HTTP listen address. Precedence: --bind flag > config server.bind > 127.0.0.1:6683.")

	vaultFlagLocal := fs.String("vault", "", "Absolute path to vault directory (bypasses the picker)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *vaultFlagLocal != "" {
		vaultFlag = *vaultFlagLocal
	}

	log := serveLog

	// Vault resolution precedence:
	//   1. --vault <abs>       (CLI override; CI/E2E; bypasses picker)
	//   2. app.json current_vault (read by resolveVaultMode in lifecycle.Run)
	//   3. picker UI at /
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

	// Load config from the default data dir to read server.bind.
	// Best-effort: if the file is absent or malformed, Defaults() applies.
	// Vault-specific config is handled by lifecycle.Run; this load is only
	// for the bind address resolution that must happen before listen().
	dataDir := config.DefaultDataDir()
	if absVault != "" {
		dataDir = absVault
	}
	persistedCfg, _ := config.Load(dataDir, log)

	// Detect whether --bind was explicitly passed on the command line.
	var bindFlagExplicit bool
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "bind" {
			bindFlagExplicit = true
		}
	})

	resolvedAddr, err := resolveBindAddr(persistedCfg, *bindFlag, bindFlagExplicit)
	if err != nil {
		return err
	}

	// HTTP path: warn (not block) when resolved host is non-loopback (NET-01).
	// MCP remains loopback-only via its own RequireLoopbackBind call in mcp/listener.go.
	if host, _, _ := net.SplitHostPort(resolvedAddr); !netbind.IsLoopback(host) {
		log.Warn("HTTP listener bound beyond loopback — only use on trusted networks",
			"addr", resolvedAddr)
	}

	cfg := app.Config{
		DataDir:       absVault,
		Server:        config.ServerConfig{Port: 6683, DataDir: absVault},
		ListenAddr:    resolvedAddr,
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

	return a.Run(ctx)
}
