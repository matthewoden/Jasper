package vault

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Canonicalize returns the canonical form of an absolute path per V10:
//
//	filepath.Abs → filepath.EvalSymlinks (if the path exists) → filepath.Clean
//	→ (on darwin) strings.ToLower.
//
// Used for recent_vaults dedup so trailing slashes, symlink aliases, and
// mixed-case paths on case-insensitive APFS/HFS+ collapse to one key.
// Non-existent paths still produce a canonical form (no EvalSymlinks step)
// so the picker can register a vault before its folder is created.
func Canonicalize(p string) (string, error) {
	if p == "" {
		return "", errors.New("vault.Canonicalize: empty path")
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("vault.Canonicalize: path must be absolute, got %q", p)
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", fmt.Errorf("abs: %w", err)
	}

	if _, statErr := os.Stat(abs); statErr == nil {
		resolved, err := filepath.EvalSymlinks(abs)
		if err == nil {
			abs = resolved
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("EvalSymlinks: %w", err)
		}
	}
	abs = filepath.Clean(abs)
	if runtime.GOOS == "darwin" {
		abs = strings.ToLower(abs)
	}
	return abs, nil
}
