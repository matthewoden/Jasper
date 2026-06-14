// Package installer wraps github.com/kardianos/service with Jasper's
// custom launchd plist + systemd user-unit templates. It ensures
// `KeepAlive: {Crashed: true}` + `ThrottleInterval=60` on macOS and
// `Restart=on-failure` + `RestartSec=60` on systemd.
//
// Public surface:
//
//   - New(dataDir) — factory returning a configured service.Service.
//     Caller invokes svc.Install / Uninstall / Start / Stop / Status.
//
//   - BootstrapMacOS(plistPath) / BootoutMacOS(plistPath) — modern
//     launchctl bootstrap/bootout wrappers (legacy `launchctl load/unload`
//     is deprecated since macOS 10.10). Use these instead of svc.Start/Stop
//     on macOS.
//
//   - PlistPathMacOS() — returns ~/Library/LaunchAgents/com.jasper.server.plist.
//
//   - EnableLingerLinux / DisableLingerLinux — `loginctl enable-linger`
//     wrappers (kardianos does NOT call enable-linger; without it the user
//     unit stops the moment the WSL terminal closes).
package installer

import (
	"fmt"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"

	"github.com/kardianos/service"
)

const serviceName = "com.jasper.server"

// New returns a configured service.Service for Jasper. The caller
// invokes Install / Uninstall / Status / Start / Stop on it.
//
// The Config wires:
//   - Name: "com.jasper.server" — launchd label + systemd unit name
//   - UserService: true — per-user install (no sudo on macOS; user unit on Linux)
//   - LaunchdConfig: launchdPlist (CRITICAL: overrides kardianos default template)
//   - SystemdScript: systemdUnit (CRITICAL: overrides kardianos default template)
//   - LogDirectory: <dataDir>/logs
//   - EnvVars: JASPER_DATA_DIR=<dataDir>
//
// The Program (first arg to service.New) is nil because the install/
// uninstall subcommands only need the registration surface. When the
// installed service starts the binary, it invokes `jasper serve` via
// Arguments.
func New(dataDir string) (service.Service, error) {
	cfg := &service.Config{
		Name:        serviceName,
		DisplayName: "Jasper",
		Description: "Jasper local markdown notes server",
		Arguments:   []string{"serve"},
		Option: service.KeyValue{
			"UserService":   true,
			"RunAtLoad":     true,
			"LaunchdConfig": launchdPlist,
			"SystemdScript": systemdUnit,
			"LogDirectory":  filepath.Join(dataDir, "logs"),
		},
		EnvVars: map[string]string{
			"JASPER_DATA_DIR": dataDir,
		},
	}
	return service.New(nil, cfg)
}

// BootstrapMacOS calls `launchctl bootstrap gui/$(id -u) <plist>` after
// service.Install() has written the plist file. Modern launchctl form
// per Apple's launchctl(1) man page (macOS 10.10+); the legacy
// `launchctl load` form is deprecated.
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
