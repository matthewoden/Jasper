// Package installer wraps kardianos/service with Jasper's own launchd plist and
// systemd user-unit templates, because the stock templates omit the restart
// policy.
//
// Use BootstrapMacOS/BootoutMacOS rather than svc.Start/Stop on macOS — the
// legacy launchctl load/unload form is deprecated.
//
// EnableLingerLinux exists because kardianos does NOT call enable-linger, and
// without it the user unit dies the moment the WSL terminal closes.
package installer

import (
	"fmt"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"

	"github.com/kardianos/service"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

const serviceName = "com.jasper.server"

// New returns a configured service.Service for Jasper.
//
// LaunchdConfig and SystemdScript MUST stay set — they override kardianos's
// default templates, which carry no restart policy. LogDirectory puts the
// service manager's stdout/stderr under the app home; it catches what the
// structured logger cannot (panics, pre-boot stderr). dataDir here is the app
// home, so AppLogsDir — vault.LogsDir would yield ~/.jasper/.jasper/logs, a
// directory nothing creates, and systemd then fails the unit with 209/STDOUT.
//
// Program is nil: the install/uninstall subcommands need only the registration
// surface.
//
// EnvVars stays empty deliberately. The unit used to carry
// Environment=JASPER_DATA_DIR=<app home>, which ADR-0008 retired: the served
// vault comes from current_vault in app.json, so the line had no effect and
// named the app home rather than a vault. A unit file is the first thing read
// when an install misbehaves, and that one invited editing a variable nothing
// consumes. Both templates skip the block when the map is empty.
func New(dataDir string) (service.Service, error) {
	return service.New(nil, newConfig(dataDir))
}

// newConfig is split out so a test can assert what the installed unit will
// declare without going through service.New, which hides the config.
func newConfig(dataDir string) *service.Config {
	return &service.Config{
		Name:        serviceName,
		DisplayName: "Jasper",
		Description: "Jasper local markdown notes server",
		Arguments:   []string{"serve"},
		Option: service.KeyValue{
			"UserService":   true,
			"RunAtLoad":     true,
			"LaunchdConfig": launchdPlist,
			"SystemdScript": systemdUnit,
			"LogDirectory":  vault.AppLogsDir(dataDir),
		},
	}
}

// BootstrapMacOS calls `launchctl bootstrap gui/$(id -u) <plist>` after
// service.Install() writes the plist. The legacy `launchctl load` is deprecated.
//
// kardianos/service still uses the legacy form internally — we work
// around by NOT calling svc.Start() on macOS and instead invoking the
// modern bootstrap form ourselves.
//
// No-op on non-darwin GOOS.
func BootstrapMacOS(plistPath string) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	u, err := user.Current()
	if err != nil {
		return fmt.Errorf("user.Current: %w", err)
	}
	cmd := exec.Command("launchctl", "bootstrap", "gui/"+u.Uid, plistPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl bootstrap gui/%s %s: %w (out: %s)", u.Uid, plistPath, err, out)
	}
	return nil
}

// BootoutMacOS is the inverse of BootstrapMacOS — call before
// service.Uninstall() so the launch daemon is removed from the running
// launchd domain before its plist is deleted.
//
// Errors are swallowed: if the agent wasn't loaded, bootout returns
// non-zero, but for an idempotent uninstall path that's the correct
// behavior. Callers can re-run uninstall safely.
//
// No-op on non-darwin GOOS.
func BootoutMacOS(plistPath string) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	u, err := user.Current()
	if err != nil {
		return fmt.Errorf("user.Current: %w", err)
	}

	_ = exec.Command("launchctl", "bootout", "gui/"+u.Uid, plistPath).Run()
	return nil
}

// PlistPathMacOS returns the canonical per-user LaunchAgent plist path
// (~/Library/LaunchAgents/com.jasper.server.plist).
//
// kardianos/service uses the same path internally on UserService=true,
// so this function exists to give callers (install subcommand,
// `jasper doctor`) a single source of truth for the path without
// reaching into kardianos internals.
func PlistPathMacOS() (string, error) {
	u, err := user.Current()
	if err != nil {
		return "", fmt.Errorf("user.Current: %w", err)
	}
	return filepath.Join(u.HomeDir, "Library", "LaunchAgents", serviceName+".plist"), nil
}
