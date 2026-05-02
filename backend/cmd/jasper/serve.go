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
	a, err := app.New(app.Config{
		DataDir:    absDataDir,
		ListenAddr: *addrFlag,
		Logger:     log,
	})
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
