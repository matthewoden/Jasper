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
)

// statusProvider is the read-side of kardianos's service.Service that
// status uses. Defining it as a local interface lets tests inject a
// fake instead of constructing a real launchd / systemd handle.
type statusProvider interface {
	Status() (service.Status, error)
}

// statusFactory is the injectable seam for tests. Production wiring
// returns installer.New(dataDir); tests replace it with a fake that
// returns whatever service.Status the test wants to assert on.
var statusFactory = func(dataDir string) (statusProvider, error) {
	return installer.New(dataDir)
}

// statusCmd prints the running service's state in plain English per
// D-36. Multi-line, human-readable; the JSON form lives on `doctor`.
var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show the running service's state and configuration",
	Long: `Print the current Jasper service state in plain English:
  - Service state (running / stopped / unknown)
  - Bound HTTP address (e.g., 127.0.0.1:6683)
  - Data directory location
  - Log file path
  - MCP-enabled flag and per-grant summary

This is read-only; it does not modify any service files.`,
	RunE: runStatus,
}

func runStatus(cmd *cobra.Command, _ []string) error {
	out := cmd.OutOrStdout()
	dataDir := os.Getenv("JASPER_DATA_DIR")
	if dataDir == "" {
		dataDir = config.DefaultDataDir()
	}

	// Probe for an existing config.json. If absent (or unreadable), tell
	// the user to run the first-run wizard instead of attempting to read
	// service state — without a config there's no port to report and no
	// MCP flag to summarize.
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

// summarizeGrants opens the DB read-only and lists grants for the
// status line. Returns the count and a human-readable summary like
// "2 grants (Tier 1 in projects/; Tier 2 in scratch/)". Empty body
// when MCP is on but no grants have been issued yet.
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
