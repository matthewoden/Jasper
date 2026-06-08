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
	"github.com/matthewoden/jasper/backend/internal/vault"
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
	appJSONPath, _ := vault.AppJSONPath()
	appState, _ := vault.LoadAppJSON(appJSONPath)

	currentVault := ""
	if vaultFlag != "" {
		if c, err := vault.Canonicalize(vaultFlag); err == nil {
			currentVault = c
		} else {
			currentVault = vaultFlag
		}
	} else if appState != nil {
		currentVault = appState.CurrentVault
	}

	dataDir := currentVault
	if dataDir == "" {
		dataDir = config.DefaultDataDir()
	}

	cfg, _ := config.Load(dataDir, slog.New(slog.NewTextHandler(io.Discard, nil)))

	checks := []DoctorCheck{
		checkWslSystemd(),
		checkLinger(),
		checkPortAvailable("server.port", cfg.Server.Port),
		mcpPortCheck(cfg),
		checkAppJSONReadable(appJSONPath),
		checkCurrentVaultExists(currentVault),
		checkCurrentVaultHasJasperDir(currentVault),
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

func mcpPortCheck(cfg config.Config) DoctorCheck {
	if !cfg.MCP.Enabled {
		return DoctorCheck{Name: "mcp.port", Status: "skip", Hint: "MCP disabled in config"}
	}
	return checkPortAvailable("mcp.port", cfg.MCP.Port)
}

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

func checkPortAvailable(label string, port int) DoctorCheck {
	if port <= 0 || port > 65535 {
		return DoctorCheck{Name: label, Status: "fail", Hint: "invalid port " + strconv.Itoa(port) + " in config.json"}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return DoctorCheck{
			Name:   label,
			Status: "fail",
			Hint:   "port " + strconv.Itoa(port) + " in use — change " + label + " in <vault>/.jasper/config.json and restart",
		}
	}
	_ = ln.Close()
	return DoctorCheck{Name: label, Status: "ok"}
}

func checkDataDirPerms(dir string) DoctorCheck {
	checkDir := dir
	if jasperDir := filepath.Join(dir, vault.SubdirName); pathIsDir(jasperDir) {
		checkDir = jasperDir
	}
	fi, err := os.Stat(checkDir)
	if err != nil {
		return DoctorCheck{
			Name:   "data-dir perms",
			Status: "fail",
			Hint:   "data directory missing at " + checkDir + " — run the first-run wizard",
		}
	}
	if !fi.IsDir() {
		return DoctorCheck{
			Name:   "data-dir perms",
			Status: "fail",
			Hint:   checkDir + " is not a directory",
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
			Hint:   fmt.Sprintf("expected mode 0700, got %#o — run 'chmod 0700 %s'", mode, checkDir),
		}
	}
	return DoctorCheck{Name: "data-dir perms", Status: "ok"}
}

func pathIsDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

func checkMigrationState(dir string) DoctorCheck {
	dbPath := vault.AppDBPath(dir)
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

	applied := map[string]bool{}
	rows, queryErr := db.Query(`SELECT version FROM schema_migrations`)
	if queryErr != nil {
		msg := queryErr.Error()
		if strings.Contains(msg, "no such table") {
			return DoctorCheck{
				Name:   "migration state",
				Status: "fail",
				Hint:   "schema_migrations table missing — restart 'jasper serve' to apply migrations",
			}
		}
		return DoctorCheck{
			Name:   "migration state",
			Status: "fail",
			Hint:   "query schema_migrations: " + msg,
		}
	}
	for rows.Next() {
		var v string
		if scanErr := rows.Scan(&v); scanErr != nil {
			_ = rows.Close()
			return DoctorCheck{Name: "migration state", Status: "fail", Hint: "scan schema_migrations.version: " + scanErr.Error()}
		}
		applied[v] = true
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		return DoctorCheck{Name: "migration state", Status: "fail", Hint: "iterate schema_migrations: " + rowsErr.Error()}
	}
	_ = rows.Close()

	entries, err := migrations.FS.ReadDir(".")
	if err != nil {
		return DoctorCheck{Name: "migration state", Status: "fail", Hint: "could not enumerate embedded migrations"}
	}
	var missing []string
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".sql") {
			continue
		}
		if !applied[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return DoctorCheck{
			Name:   "migration state",
			Status: "fail",
			Hint:   fmt.Sprintf("pending migrations: %s — restart 'jasper serve' to apply", strings.Join(missing, ", ")),
		}
	}
	return DoctorCheck{Name: "migration state", Status: "ok"}
}

func checkLogWritable(dir string) DoctorCheck {
	logsDir := filepath.Join(dir, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return DoctorCheck{Name: "log writable", Status: "fail", Hint: "cannot mkdir " + logsDir + ": " + err.Error()}
	}
	probePath := filepath.Join(logsDir, fmt.Sprintf(".write-probe-%d", os.Getpid()))
	f, err := os.OpenFile(probePath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
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
		return DoctorCheck{
			Name:   "log writable",
			Status: "ok",
			Hint:   "probe write OK but cleanup failed: " + rerr.Error(),
		}
	}
	return DoctorCheck{Name: "log writable", Status: "ok"}
}

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

func checkAppJSONReadable(appJSONPath string) DoctorCheck {
	_, err := vault.LoadAppJSON(appJSONPath)
	if err != nil {
		return DoctorCheck{
			Name:   "app.json readable at " + appJSONPath,
			Status: "fail",
			Hint:   "app.json write failed after corrupt-backup-reset: " + err.Error(),
		}
	}
	return DoctorCheck{Name: "app_json_readable", Status: "ok"}
}

func checkCurrentVaultExists(currentVault string) DoctorCheck {
	if currentVault == "" {
		return DoctorCheck{Name: "current_vault_exists", Status: "skip", Hint: "no current_vault set"}
	}
	if _, err := os.Stat(currentVault); err != nil {
		return DoctorCheck{
			Name:   "current_vault_exists",
			Status: "fail",
			Hint:   "Run `jasper` and use the vault picker to select or create a vault.",
		}
	}
	return DoctorCheck{Name: "current_vault_exists", Status: "ok"}
}

func checkCurrentVaultHasJasperDir(currentVault string) DoctorCheck {
	if currentVault == "" {
		return DoctorCheck{Name: "current_vault_has_jasper_dir", Status: "skip", Hint: "no current_vault set"}
	}
	jasperDir := filepath.Join(currentVault, vault.SubdirName)
	if _, err := os.Stat(jasperDir); err != nil {
		return DoctorCheck{
			Name:   "current_vault_has_jasper_dir",
			Status: "fail",
			Hint:   "Vault folder exists but is missing .jasper/ — open the vault via the picker; the create-existing flow will recreate it.",
		}
	}
	return DoctorCheck{Name: "current_vault_has_jasper_dir", Status: "ok"}
}
