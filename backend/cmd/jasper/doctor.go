package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	_ "modernc.org/sqlite" // pure-Go SQLite driver

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/static"
	"github.com/matthewoden/jasper/backend/migrations"
)

var doctorJSON bool

var doctorCmd = &cobra.Command{
	Use:   "doctor",
	Short: "Diagnose install + runtime issues with plain-English remediation",
	Long: `Run a set of checks and print actionable remediation for each failure.

Checks (in order):
  1. WSL2: systemd=true in /etc/wsl.conf       — fix: edit wsl.conf, then wsl --shutdown
  2. Linux: loginctl enable-linger              — fix: loginctl enable-linger $USER
  3. server.port (default 6683) is available    — fix: change config.json server.port
  4. mcp.port (if enabled) is available         — fix: change config.json mcp.port
  5. Data-dir is writable + owned by you        — fix: chmod 0700 the data dir
  6. Migrations applied                          — fix: rerun jasper serve to apply
  7. Log file is writable                        — fix: chmod 0644 the log file
  8. Frontend bundle present in binary          — fix: rebuild via make build

Exit code: 0 if all green; 1 if any failure.

Use --json for structured output (suitable for support tooling).`,
	RunE: runDoctor,
}

func init() {
	doctorCmd.Flags().BoolVar(&doctorJSON, "json", false, "emit checks as a JSON array")
	rootCmd.AddCommand(doctorCmd)
}

// DoctorCheck is the wire-shape of one row in `jasper doctor --json`.
// Per D-37: name + status (ok/fail/skip) + optional hint string.
type DoctorCheck struct {
	Name   string `json:"name"`
	Status string `json:"status"` // "ok" | "fail" | "skip"
	Hint   string `json:"hint,omitempty"`
}

func runDoctor(cmd *cobra.Command, _ []string) error {
	dataDir := os.Getenv("JASPER_DATA_DIR")
	if dataDir == "" {
		dataDir = config.DefaultDataDir()
	}
	cfg, _ := config.Load(dataDir, slog.New(slog.NewTextHandler(io.Discard, nil)))

	checks := []DoctorCheck{
		checkWslSystemd(),
		checkLinger(),
		checkPortAvailable("server.port", cfg.Server.Port),
		mcpPortCheck(cfg),
		checkDataDirPerms(dataDir),
		checkMigrationState(dataDir),
		checkLogWritable(dataDir),
		checkFrontendEmbed(),
	}

	anyFail := false
	for _, r := range checks {
		if r.Status == "fail" {
			anyFail = true
		}
	}

	out := cmd.OutOrStdout()
	if doctorJSON {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		if err := enc.Encode(checks); err != nil {
			return err
		}
	} else {
		for _, r := range checks {
			marker := "✓"
			switch r.Status {
			case "fail":
				marker = "✗"
			case "skip":
				marker = "·"
			}
			if _, err := fmt.Fprintf(out, "%s %s", marker, r.Name); err != nil {
				return err
			}
			if r.Hint != "" {
				if _, err := fmt.Fprintf(out, " — fix: %s", r.Hint); err != nil {
					return err
				}
			}
			if _, err := fmt.Fprintln(out); err != nil {
				return err
			}
		}
	}
	if anyFail {
		return errors.New("doctor: one or more checks failed")
	}
	return nil
}

// mcpPortCheck wraps checkPortAvailable for the MCP port and short-
// circuits to a skip when MCP is disabled in config.
func mcpPortCheck(cfg config.Config) DoctorCheck {
	if !cfg.MCP.Enabled {
		return DoctorCheck{Name: "mcp.port", Status: "skip", Hint: "MCP disabled in config"}
	}
	return checkPortAvailable("mcp.port", cfg.MCP.Port)
}

// checkWslSystemd reads /etc/wsl.conf and verifies the [boot]/systemd=true block.
// On macOS or non-WSL Linux, skip (the unit isn't applicable).
func checkWslSystemd() DoctorCheck {
	if runtime.GOOS != "linux" {
		return DoctorCheck{Name: "wsl.conf systemd", Status: "skip", Hint: "macOS — N/A"}
	}
	rel, _ := os.ReadFile("/proc/sys/kernel/osrelease")
	if !strings.Contains(strings.ToLower(string(rel)), "microsoft") {
		return DoctorCheck{Name: "wsl.conf systemd", Status: "skip", Hint: "native Linux — N/A"}
	}
	body, err := os.ReadFile("/etc/wsl.conf")
	if err != nil {
		return DoctorCheck{
			Name:   "wsl.conf systemd",
			Status: "fail",
			Hint:   "create /etc/wsl.conf with [boot]\\nsystemd=true, then run 'wsl --shutdown' from a Windows admin prompt",
		}
	}
	bootRe := regexp.MustCompile(`(?ms)^\s*\[boot\]\s*$([^[]*)`)
	m := bootRe.FindStringSubmatch(string(body))
	if m == nil {
		return DoctorCheck{
			Name:   "wsl.conf systemd",
			Status: "fail",
			Hint:   "add [boot]\\nsystemd=true to /etc/wsl.conf, then run 'wsl --shutdown'",
		}
	}
	if regexp.MustCompile(`(?m)^\s*systemd\s*=\s*true\s*$`).MatchString(m[1]) {
		return DoctorCheck{Name: "wsl.conf systemd", Status: "ok"}
	}
	return DoctorCheck{
		Name:   "wsl.conf systemd",
		Status: "fail",
		Hint:   "add 'systemd=true' under [boot] in /etc/wsl.conf, then run 'wsl --shutdown'",
	}
}

// checkLinger uses loginctl to verify the current user has linger enabled.
// On macOS, skip — no analog.
func checkLinger() DoctorCheck {
	if runtime.GOOS != "linux" {
		return DoctorCheck{Name: "loginctl linger", Status: "skip", Hint: "macOS — N/A"}
	}
	u, err := user.Current()
	if err != nil {
		return DoctorCheck{Name: "loginctl linger", Status: "fail", Hint: "could not determine current user"}
	}
	out, err := exec.Command("loginctl", "show-user", u.Username, "--property=Linger").Output()
	if err != nil {
		return DoctorCheck{
			Name:   "loginctl linger",
			Status: "fail",
			Hint:   "run 'loginctl enable-linger " + u.Username + "' (or re-run 'jasper install')",
		}
	}
	if strings.Contains(strings.TrimSpace(string(out)), "Linger=yes") {
		return DoctorCheck{Name: "loginctl linger", Status: "ok"}
	}
	return DoctorCheck{
		Name:   "loginctl linger",
		Status: "fail",
		Hint:   "run 'loginctl enable-linger " + u.Username + "' (or re-run 'jasper install')",
	}
}

// checkPortAvailable tries to bind 127.0.0.1:<port> and immediately closes.
// If bind fails, the port is in use (or the binary lacks permission).
func checkPortAvailable(label string, port int) DoctorCheck {
	if port <= 0 || port > 65535 {
		return DoctorCheck{Name: label, Status: "fail", Hint: "invalid port " + strconv.Itoa(port) + " in config.json"}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return DoctorCheck{
			Name:   label,
			Status: "fail",
			Hint:   "port " + strconv.Itoa(port) + " in use — change " + label + " in ~/.jasper/storage/config.json and restart",
		}
	}
	_ = ln.Close()
	return DoctorCheck{Name: label, Status: "ok"}
}

// checkDataDirPerms ensures the data directory exists and has mode 0700.
// A wider mode (e.g., 0777) is a fail because notes shouldn't be world-readable.
func checkDataDirPerms(dir string) DoctorCheck {
	fi, err := os.Stat(dir)
	if err != nil {
		return DoctorCheck{
			Name:   "data-dir perms",
			Status: "fail",
			Hint:   "data directory missing at " + dir + " — run the first-run wizard",
		}
	}
	if !fi.IsDir() {
		return DoctorCheck{
			Name:   "data-dir perms",
			Status: "fail",
			Hint:   dir + " is not a directory",
		}
	}
	if runtime.GOOS == "windows" {
		return DoctorCheck{Name: "data-dir perms", Status: "ok", Hint: "Windows — mode check skipped"}
	}
	mode := fi.Mode().Perm()
	if mode != 0o700 {
		return DoctorCheck{
			Name:   "data-dir perms",
			Status: "fail",
			Hint:   fmt.Sprintf("expected mode 0700, got %#o — run 'chmod 0700 %s'", mode, dir),
		}
	}
	return DoctorCheck{Name: "data-dir perms", Status: "ok"}
}

// checkMigrationState compares the latest applied migration version against
// the highest embedded migration file. Mismatch = pending migrations.
func checkMigrationState(dir string) DoctorCheck {
	dbPath := filepath.Join(dir, "storage", "app.db")
	if _, err := os.Stat(dbPath); err != nil {
		return DoctorCheck{
			Name:   "migration state",
			Status: "fail",
			Hint:   "app.db missing at " + dbPath + " — run the first-run wizard or 'jasper serve' once",
		}
	}
	db, err := sql.Open("sqlite", dbPath+"?mode=ro")
	if err != nil {
		return DoctorCheck{Name: "migration state", Status: "fail", Hint: "could not open app.db: " + err.Error()}
	}
	defer func() { _ = db.Close() }()
	var maxApplied int
	err = db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&maxApplied)
	if err != nil {
		return DoctorCheck{
			Name:   "migration state",
			Status: "fail",
			Hint:   "schema_migrations table missing — restart 'jasper serve' to apply migrations",
		}
	}
	// Count embedded .sql files to derive the highest version number.
	entries, err := migrations.FS.ReadDir(".")
	if err != nil {
		return DoctorCheck{Name: "migration state", Status: "fail", Hint: "could not enumerate embedded migrations"}
	}
	maxEmbedded := 0
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".sql") {
			continue
		}
		// Filename pattern: NNN_*.sql — parse leading number.
		for i := 0; i < len(name); i++ {
			if name[i] < '0' || name[i] > '9' {
				if v, err := strconv.Atoi(name[:i]); err == nil && v > maxEmbedded {
					maxEmbedded = v
				}
				break
			}
		}
	}
	if maxApplied < maxEmbedded {
		return DoctorCheck{
			Name:   "migration state",
			Status: "fail",
			Hint:   fmt.Sprintf("applied=%d, embedded=%d — restart 'jasper serve' to apply pending migrations", maxApplied, maxEmbedded),
		}
	}
	return DoctorCheck{Name: "migration state", Status: "ok"}
}

// checkLogWritable probes write-permission against the logs directory WITHOUT
// touching jasper.log itself (Plan 08-12 revision 2 Blocker 3 — appending a
// probe byte to the real log corrupts the slog JSON stream; downstream log
// readers expect one valid JSON record per line, and a bare newline is not
// valid JSON).
//
// Strategy: open a SEPARATE probe file <logsDir>/.write-probe-<pid> with
// O_CREATE|O_WRONLY|O_EXCL (exclusive create — fails if a stale probe lingers
// from a crashed prior run; on EEXIST we fall back to O_TRUNC). Write one
// byte, close, os.Remove. Never touch jasper.log.
func checkLogWritable(dir string) DoctorCheck {
	logsDir := filepath.Join(dir, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return DoctorCheck{Name: "log writable", Status: "fail", Hint: "cannot mkdir " + logsDir + ": " + err.Error()}
	}
	probePath := filepath.Join(logsDir, fmt.Sprintf(".write-probe-%d", os.Getpid()))
	f, err := os.OpenFile(probePath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		// Fallback: O_TRUNC overwrites a stale probe from a crashed prior run.
		f, err = os.OpenFile(probePath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			return DoctorCheck{
				Name:   "log writable",
				Status: "fail",
				Hint:   "cannot create probe file in " + logsDir + ": " + err.Error(),
			}
		}
	}
	if _, werr := f.Write([]byte{'.'}); werr != nil {
		_ = f.Close()
		_ = os.Remove(probePath)
		return DoctorCheck{
			Name:   "log writable",
			Status: "fail",
			Hint:   "cannot write probe to " + probePath + ": " + werr.Error(),
		}
	}
	if cerr := f.Close(); cerr != nil {
		_ = os.Remove(probePath)
		return DoctorCheck{
			Name:   "log writable",
			Status: "fail",
			Hint:   "cannot close probe " + probePath + ": " + cerr.Error(),
		}
	}
	if rerr := os.Remove(probePath); rerr != nil {
		// Cleanup failure — the probe is benign on disk, but flag it so
		// the user can manually clean up if they care.
		return DoctorCheck{
			Name:   "log writable",
			Status: "ok",
			Hint:   "probe write OK but cleanup failed: " + rerr.Error(),
		}
	}
	return DoctorCheck{Name: "log writable", Status: "ok"}
}

// checkFrontendEmbed opens dist/index.html from the embedded static.FS.
// If the bundle is missing (binary built without `make build`), fail.
func checkFrontendEmbed() DoctorCheck {
	f, err := static.FS().Open("index.html")
	if err != nil {
		return DoctorCheck{
			Name:   "frontend embed",
			Status: "fail",
			Hint:   "dist/index.html not in binary — rebuild via 'make build' (NOT 'go build')",
		}
	}
	defer func() { _ = f.Close() }()
	buf := make([]byte, 32)
	n, _ := f.Read(buf)
	if n == 0 {
		return DoctorCheck{
			Name:   "frontend embed",
			Status: "fail",
			Hint:   "dist/index.html is empty — rebuild via 'make build'",
		}
	}
	return DoctorCheck{Name: "frontend embed", Status: "ok"}
}
