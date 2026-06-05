package main

import (
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kardianos/service"
	"github.com/spf13/cobra"

	_ "modernc.org/sqlite" // pure-Go SQLite driver

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/installer"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

type statusProvider interface {
	Status() (service.Status, error)
}

var statusFactory = func(dataDir string) (statusProvider, error) {
	return installer.New(dataDir)
}

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show the running service's state and configuration",
	Long: `Print the current Jasper service state in plain English:
  - Service state (running / stopped / unknown)
  - Bound HTTP address (e.g., 127.0.0.1:6683)
  - Current vault (from app.json or --vault override)
  - Recent vaults count
  - App home directory
  - Log file path
  - MCP-enabled flag and per-grant summary

This is read-only; it does not modify any service files.`,
	RunE: runStatus,
}

func runStatus(cmd *cobra.Command, _ []string) error {
	out := cmd.OutOrStdout()

	appJSONPath, appJSONErr := vault.AppJSONPath()
	appHome, appHomeErr := vault.AppHomePath()

	var appState *vault.AppState
	if appJSONErr == nil {
		if state, err := vault.LoadAppJSON(appJSONPath); err == nil {
			appState = state
		}
	}

	var dataDir string
	if vaultFlag != "" {
		if c, err := vault.Canonicalize(vaultFlag); err == nil {
			dataDir = c
		} else {
			dataDir = vaultFlag
		}
	} else if appState != nil && appState.CurrentVault != "" {
		dataDir = appState.CurrentVault
	} else {
		dataDir = config.DefaultDataDir()
	}

	if vaultFlag != "" {
		canonical := dataDir
		if _, err := fmt.Fprintf(out, "Vault:          (overridden via --vault) %s\n", canonical); err != nil {
			return err
		}
	} else if appState != nil && appState.CurrentVault != "" {
		name := filepath.Base(appState.CurrentVault)
		for _, e := range appState.RecentVaults {
			if e.Path == appState.CurrentVault {
				name = e.DisplayName
				break
			}
		}
		if _, err := fmt.Fprintf(out, "Vault:          %s  (%s)\n", name, appState.CurrentVault); err != nil {
			return err
		}
	} else {
		if _, err := fmt.Fprintln(out, "Vault:          (none selected — server will serve the vault picker on next request)"); err != nil {
			return err
		}
	}

	recentCount := 0
	if appState != nil {
		recentCount = len(appState.RecentVaults)
	}
	if _, err := fmt.Fprintf(out, "Recent Vaults:  %d entries\n", recentCount); err != nil {
		return err
	}

	if appState != nil {
		for _, e := range appState.RecentVaults {
			name := e.DisplayName
			if name == "" {
				name = filepath.Base(e.Path)
			}
			missing := ""
			if e.Missing {
				missing = " (missing)"
			}
			last := "never"
			if !e.LastOpenedAt.IsZero() {
				last = e.LastOpenedAt.Local().Format("2006-01-02 15:04")
			}
			if _, err := fmt.Fprintf(out, "  - %s (%s) — last opened %s%s\n",
				name, e.Path, last, missing); err != nil {
				return err
			}
		}
	}

	if appHomeErr == nil {
		if _, err := fmt.Fprintf(out, "App Home:       %s\n", appHome); err != nil {
			return err
		}
	}

	const setupHint = "Jasper is not yet set up — open http://127.0.0.1:6683/ to run the first-run wizard."
	if !configExists(dataDir) {
		_, err := fmt.Fprintln(out, setupHint)
		return err
	}

	cfg, err := config.Load(dataDir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		_, ferr := fmt.Fprintln(out, setupHint)
		return ferr
	}

	state := service.StatusUnknown
	if svc, ferr := statusFactory(dataDir); ferr == nil {
		if s, serr := svc.Status(); serr == nil {
			state = s
		}
	}

	mcpLine := "MCP enabled:    no"
	if cfg.MCP.Enabled {
		_, summary := summarizeGrants(dataDir)
		mcpLine = fmt.Sprintf("MCP enabled:    yes on 127.0.0.1:%d — %s", cfg.MCP.Port, summary)
	}
	body := fmt.Sprintf(
		"Jasper service: %s\nBound on:       127.0.0.1:%d\nData directory: %s\nLog file:       %s\n%s\n",
		humanState(state),
		cfg.Server.Port,
		dataDir,
		filepath.Join(dataDir, "logs", "jasper.log"),
		mcpLine,
	)
	_, werr := fmt.Fprint(out, body)
	return werr
}

func configExists(dataDir string) bool {
	_, err := os.Stat(filepath.Join(dataDir, "storage", "config.json"))
	return err == nil
}

func humanState(s service.Status) string {
	switch s {
	case service.StatusRunning:
		return "running"
	case service.StatusStopped:
		return "stopped"
	default:
		return "unknown (service may not be installed)"
	}
}

func summarizeGrants(dataDir string) (int, string) {
	dbPath := filepath.Join(dataDir, "storage", "app.db")
	db, err := sql.Open("sqlite", dbPath+"?mode=ro")
	if err != nil {
		return 0, "could not read grants"
	}
	defer func() { _ = db.Close() }()
	rows, err := db.Query(`SELECT folder_path, level FROM mcp_write_grants ORDER BY folder_path`)
	if err != nil {
		return 0, "could not read grants"
	}
	defer func() { _ = rows.Close() }()
	var parts []string
	n := 0
	for rows.Next() {
		var folder string
		var level int
		if err := rows.Scan(&folder, &level); err != nil {
			continue
		}
		tier := "Tier 1"
		if level == 2 {
			tier = "Tier 2"
		}
		parts = append(parts, fmt.Sprintf("%s in %s/", tier, folder))
		n++
	}
	sort.Strings(parts)
	if n == 0 {
		return 0, "no grants yet"
	}
	return n, fmt.Sprintf("%d grants (%s)", n, strings.Join(parts, "; "))
}

func init() { rootCmd.AddCommand(statusCmd) }
