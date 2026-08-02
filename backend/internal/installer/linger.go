package installer

import (
	"fmt"
	"os/exec"
	"os/user"
	"runtime"
)

// EnableLingerLinux invokes `loginctl enable-linger $USER` so the
// systemd user service runs even when no shell is logged in.
// kardianos/service does NOT call enable-linger — verified by reading
// service_systemd_linux.go.Install() against master on 2026-05-17.
//
// Without linger, the user unit only runs while at least one shell is
// logged in. On WSL2 that means closing the terminal stops Jasper;
// on a normal Linux laptop, logout (or `loginctl terminate-user`) does
// the same. Linger lifts that constraint.
//
// Idempotent: loginctl returns 0 if the user is already linged.
//
// No-op on non-Linux GOOS.
func EnableLingerLinux() error {
	if runtime.GOOS != "linux" {
		return nil
	}
	u, err := user.Current()
	if err != nil {
		return fmt.Errorf("user.Current: %w", err)
	}
	cmd := exec.Command("loginctl", "enable-linger", u.Username)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("loginctl enable-linger %s: %w (out: %s)", u.Username, err, out)
	}
	return nil
}

// DisableLingerLinux is the inverse — call from `jasper uninstall` so a
// clean uninstall leaves no per-user lifecycle state behind.
//
// Errors are swallowed: if the user wasn't linged, disable-linger
// returns non-zero, but for an idempotent uninstall path that's the
// correct behavior.
//
// No-op on non-Linux GOOS.
func DisableLingerLinux() error {
	if runtime.GOOS != "linux" {
		return nil
	}
	u, err := user.Current()
	if err != nil {
		return fmt.Errorf("user.Current: %w", err)
	}
	_ = exec.Command("loginctl", "disable-linger", u.Username).Run()
	return nil
}
