// Package platform exposes runtime host-environment probes (WSL2 detection)
// and the small path conversions that depend on them.
//
// IsWSL is implemented the same way the existing reveal handler does it —
// inspect /proc/sys/kernel/osrelease for "microsoft" (case-insensitive). The
// existing private isWSL in reveal_handler.go stays put; this package is for
// new code paths (vault picker + future surfaces that need WSL awareness).
package platform

import (
	"os"
	"regexp"
	"strings"
)

// OsreleasePath is the kernel-info file inspected by IsWSL. Overridable in
// tests so the probe can be driven against a fixture without touching /proc.
// Production value is /proc/sys/kernel/osrelease; on WSL2 it contains a
// version string like "5.15.167.4-microsoft-standard-WSL2".
//
// At process start the JASPER_OSRELEASE_PATH env var (when non-empty) takes
// precedence — used by the Docker-as-fake-WSL e2e harness in
// compose/wsl-validation/ to exercise the WSL branch from CI without a
// Windows host. Production runs leave the env var unset.
var OsreleasePath = func() string {
	if p := os.Getenv("JASPER_OSRELEASE_PATH"); p != "" {
		return p
	}
	return "/proc/sys/kernel/osrelease"
}()

// IsWSL returns true when the current host is WSL2. Detection is the
// case-insensitive substring "microsoft" in /proc/sys/kernel/osrelease.
// Returns false on macOS / native Linux / Windows / anywhere else.
func IsWSL() bool {
	b, err := os.ReadFile(OsreleasePath)
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(b)), "microsoft")
}

var mntDrive = regexp.MustCompile(`^/mnt/([a-z])(?:/(.*))?/?$`)

// WslToWindows converts /mnt/<drive>/... to its Windows form:
// /mnt/c/Users/you → C:\Users\you
//
// Returns "" for anything with no Windows equivalent. WSL does expose Linux
// paths as \\wsl$\<distro>\..., but that form is deliberately not returned —
// it is distro-specific and rarely what a Windows user means by a folder.
//
// Pure arithmetic; no wslpath shell-out.
func WslToWindows(wslPath string) string {
	m := mntDrive.FindStringSubmatch(wslPath)
	if m == nil {
		return ""
	}
	drive := strings.ToUpper(m[1])

	rest := strings.TrimRight(m[2], "/")
	if rest == "" {
		return drive + `:\`
	}
	return drive + `:\` + strings.ReplaceAll(rest, "/", `\`)
}
