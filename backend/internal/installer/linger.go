package installer

import (
	"fmt"
	"os/exec"
	"os/user"
	"runtime"
)

// EnableLingerLinux runs `loginctl enable-linger $USER`; kardianos/service does
// not. Without it the user unit only lives while a shell is logged in, so on
// WSL2 closing the terminal stops Jasper.
//
// Idempotent. No-op on non-Linux.
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
