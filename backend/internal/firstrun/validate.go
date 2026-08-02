package firstrun

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

const maxDataDirPathLen = 4096

// RefusalCode names a validation refusal case, or "" when validation
// passes. The wire format (api.SetupValidateResponseCode) uses the same
// string constants so the handler in setup_handler.go can cast directly.
type RefusalCode string

// Refusal codes — strings must match openapi.yaml's SetupValidateResponseCode.
//
// A relative path is refused rather than silently materialising a stray
// directory under the binary's launch CWD.
const (
	RefusalParentMissing RefusalCode = "parent_missing"
	RefusalNestedVault   RefusalCode = "nested_vault"
	RefusalUnwritable    RefusalCode = "unwritable"
	RefusalNonASCII      RefusalCode = "non_ascii"
	RefusalNotAbsolute   RefusalCode = "not_absolute"
)

const (
	msgParentMissing = "The parent folder doesn't exist. Create it first, then pick this path."
	msgNestedVault   = "This path is inside an existing Jasper vault. Pick a different folder."
	msgNonASCII      = "Path contains characters that don't survive cross-platform sync. Use plain ASCII letters, digits, dashes, and forward slashes."

	msgUnwritableFmt = "Jasper can't write here: %s. Check folder permissions."

	msgNotAbsolute = "Pick an absolute path (starts with `/`) or a path beginning with `~/`."
)

// ValidateResult is the outcome of ValidateDataDir. Valid is true only
// when no refusal rule fires; otherwise Code carries the machine-readable
// rule name and Message carries the locked UI string.
type ValidateResult struct {
	Valid   bool
	Code    RefusalCode
	Message string
}

// ResolveDataDir tilde-expands then enforces an absolute path. "~user" is NOT
// supported and falls through to the absolute check.
//
// The absolute requirement is not cosmetic: a relative path reaches sqlite.Open
// as a confusing "dbPath must be absolute", and the write probe would first
// create a stray directory tree under the binary's launch CWD.
//
// Does no filesystem I/O.
func ResolveDataDir(raw string) (string, RefusalCode, string) {
	expanded := raw
	if raw == "~" || strings.HasPrefix(raw, "~/") {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return "", RefusalNotAbsolute, msgNotAbsolute
		}
		if raw == "~" {
			expanded = home
		} else {
			expanded = filepath.Join(home, raw[2:])
		}
	}

	if !filepath.IsAbs(expanded) {
		return "", RefusalNotAbsolute, msgNotAbsolute
	}

	return filepath.Clean(expanded), "", ""
}

// ValidateDataDir short-circuits on the first refusal. Order matters: the
// absolute-path check must precede the write probe, or the probe creates a
// stray directory tree under the launch CWD.
//
// The underlying os.Error is surfaced for the unwritable case — the user is
// local and already controls the filesystem, and the UI needs remediation.
func ValidateDataDir(path string) ValidateResult {
	if len(path) > maxDataDirPathLen {
		return ValidateResult{Code: RefusalNonASCII, Message: msgNonASCII}
	}

	resolved, refusalCode, refusalMsg := ResolveDataDir(path)
	if refusalCode != "" {
		return ValidateResult{Code: refusalCode, Message: refusalMsg}
	}
	path = resolved

	if !norm.NFC.IsNormalString(path) {
		return ValidateResult{Code: RefusalNonASCII, Message: msgNonASCII}
	}
	for _, r := range path {
		if r > unicode.MaxASCII {
			return ValidateResult{Code: RefusalNonASCII, Message: msgNonASCII}
		}
	}

	parent := filepath.Dir(path)
	if _, err := os.Stat(parent); errors.Is(err, fs.ErrNotExist) {
		return ValidateResult{Code: RefusalParentMissing, Message: msgParentMissing}
	}

	if isInsideExistingVault(path) {
		return ValidateResult{Code: RefusalNestedVault, Message: msgNestedVault}
	}

	if err := os.MkdirAll(path, 0o700); err != nil {
		return ValidateResult{Code: RefusalUnwritable, Message: fmt.Sprintf(msgUnwritableFmt, err.Error())}
	}
	probe, err := os.CreateTemp(path, ".jasper-write-probe-*")
	if err != nil {
		return ValidateResult{Code: RefusalUnwritable, Message: fmt.Sprintf(msgUnwritableFmt, err.Error())}
	}
	probeName := probe.Name()
	_ = probe.Close()
	_ = os.Remove(probeName)
	return ValidateResult{Valid: true}
}

func isInsideExistingVault(path string) bool {
	cur := filepath.Dir(path)
	for {
		parent := filepath.Dir(cur)
		if parent == cur {
			return false
		}
		if isDir(filepath.Join(parent, "notes")) && fileExists(vault.AppDBPath(parent)) {
			return true
		}
		cur = parent
	}
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
