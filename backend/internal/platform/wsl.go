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
var OsreleasePath = "/proc/sys/kernel/osrelease"

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

// mntDrive matches WSL's /mnt/<drive-letter>(/...) prefix that maps to a
// Windows drive. Drive letters are normalized to lowercase in /mnt/ regardless
// of how the user types them, so the pattern is [a-z] (single character).
//
// The (?:/(.*))? captures the rest after /mnt/<drive>, including the empty
// case (path is exactly "/mnt/c" or "/mnt/c/"). filepath.Clean is the caller's
// responsibility — this regex matches both clean and trailing-slash inputs.
var mntDrive = regexp.MustCompile(`^/mnt/([a-z])(?:/(.*))?/?$`)

// WslToWindows converts a WSL absolute path under /mnt/<drive>/... to its
// Windows-form equivalent.
//
//	/mnt/c                       → C:\
//	/mnt/c/Users/you             → C:\Users\you
//	/mnt/c/Users/you/Documents/  → C:\Users\you\Documents
//
// Returns "" when the input has no Windows equivalent: Linux-only paths like
// /home/me/..., relative paths, the empty string, or any path that doesn't
// match the /mnt/<drive>(/...) prefix. WSL exposes Linux paths to Windows
// via the \\wsl$\<distro>\... UNC namespace but we deliberately don't return
// that form — it's awkward, distro-specific, and rarely what a Windows user
// is thinking of when they pick a folder.
//
// Pure function, no shell-out. Callers don't need to set up a wslpath binary
// or worry about latency — this is the same arithmetic wslpath would do for
// the /mnt/ case.
func WslToWindows(wslPath string) string {
	m := mntDrive.FindStringSubmatch(wslPath)
	if m == nil {
		return ""
	}
	drive := strings.ToUpper(m[1])
	// `(.*)` in mntDrive is greedy and swallows any trailing slash even with
	// the outer `/?` optional separator. Strip it so the output never ends
	// with a stray backslash.
	rest := strings.TrimRight(m[2], "/")
	if rest == "" {
		return drive + `:\`
	}
	return drive + `:\` + strings.ReplaceAll(rest, "/", `\`)
}
