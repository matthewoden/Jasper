package main

import (
	"fmt"
	"os"
	"runtime"
	"strings"

	"github.com/spf13/cobra"

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/installer"
)

var installCmd = &cobra.Command{
	Use:   "install",
	Short: "Register Jasper as a per-user OS service",
	Long: `Register Jasper as a per-user service that starts at login.

On macOS: writes ~/Library/LaunchAgents/com.jasper.server.plist with
KeepAlive on crash, ThrottleInterval=60s, and bootstraps it via
launchctl bootstrap gui/<uid>. No sudo required.

On WSL2 / Linux: writes ~/.config/systemd/user/jasper.service,
enables linger (so the service runs without an open shell), and
starts it via systemctl --user. Requires WSL2 with systemd=true in
/etc/wsl.conf — if you see "Failed to connect to bus", set:

  [boot]
  systemd=true

in /etc/wsl.conf, then run "wsl --shutdown" from a Windows admin
prompt to restart WSL.

After install, "jasper status" confirms the service is running.

Migrations are NOT run by install — they run on the first "jasper
serve" invocation (or the first-run wizard submit). Install stays
fast and idempotent.`,
	RunE: runInstall,
}

func runInstall(_ *cobra.Command, _ []string) error {
	dataDir := config.DefaultDataDir()

	svc, err := installer.New(dataDir)
	if err != nil {
		return fmt.Errorf("create service config: %w", err)
	}

	if err := svc.Install(); err != nil {
		if !isAlreadyInstalled(err) {
			return fmt.Errorf("install service: %w", err)
		}
		fmt.Fprintln(os.Stderr, "(service file already exists — continuing)")
	}

	switch runtime.GOOS {
	case "darwin":
		plistPath, err := installer.PlistPathMacOS()
		if err != nil {
			return fmt.Errorf("resolve plist path: %w", err)
		}
		if err := installer.BootstrapMacOS(plistPath); err != nil {
			return fmt.Errorf("bootstrap launchd: %w", err)
		}
		fmt.Printf("Installed Jasper as a launchd LaunchAgent.\n  Plist: %s\n", plistPath)
	case "linux":
		if err := installer.EnableLingerLinux(); err != nil {
			return fmt.Errorf("enable-linger: %w", err)
		}
		if err := svc.Start(); err != nil {
			return fmt.Errorf("start service: %w", err)
		}
		fmt.Println("Installed Jasper as a systemd user unit.")
		fmt.Println("  Unit: ~/.config/systemd/user/jasper.service")
		fmt.Println("  Lingering enabled — runs without an open shell.")
	default:
		return fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}

	fmt.Println("Next: open http://127.0.0.1:6683/ to finish setup.")
	return nil
}

func isAlreadyInstalled(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "already installed") || strings.Contains(msg, "exists")
}

func init() { rootCmd.AddCommand(installCmd) }
