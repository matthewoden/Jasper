package firstrun

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// maxDataDirPathLen caps the wizard's data-dir input at 4096 bytes
// BEFORE any os.Stat / NFC walk runs. Threat T-08-07 (RESEARCH §Security
// row "Wizard data-dir DoS via huge path probe"): a hostile or
// accidentally-pasted path of MB-scale length would otherwise drive
// the unicode walk and norm.NFC.IsNormalString through O(len) work
// per request. 4096 is comfortably above any plausible legitimate
// path (PATH_MAX on macOS is 1024; Linux is 4096).
const maxDataDirPathLen = 4096

// RefusalCode names one of the four D-08 refusal cases or "" when
// the validation passes. The wire format (api.SetupValidateResponseCode)
// uses the same string constants — so the handler in setup_handler.go
// can cast directly.
type RefusalCode string

// The four D-08 refusal codes. Strings match openapi.yaml's
// SetupValidateResponseCode enum (generated as
// api.SetupValidateResponseCode constants ParentMissing, NestedVault,
// Unwritable, NonAscii).
const (
	RefusalParentMissing RefusalCode = "parent_missing"
	RefusalNestedVault   RefusalCode = "nested_vault"
	RefusalUnwritable    RefusalCode = "unwritable"
	RefusalNonASCII      RefusalCode = "non_ascii"
)

// LOCKED refusal messages (UI-SPEC §Copywriting Contract lines 134-143).
// Do NOT paraphrase — the wizard frontend (08-04) renders these
// verbatim and the ui-checker plan flags any drift.
const (
	msgParentMissing = "The parent folder doesn't exist. Create it first, then pick this path."
	msgNestedVault   = "This path is inside an existing Jasper vault. Pick a different folder."
	msgNonASCII      = "Path contains characters that don't survive cross-platform sync. Use plain ASCII letters, digits, dashes, and forward slashes."
	// unwritable format string: "Jasper can't write here: %s. Check folder permissions."
	// — the %s is the underlying os error per UI-SPEC.
	msgUnwritableFmt = "Jasper can't write here: %s. Check folder permissions."
)

// ValidateResult is the outcome of ValidateDataDir. Valid is true ONLY
// when none of the four D-08 rules fires; otherwise Code carries the
// machine-readable rule name and Message carries the locked UI string.
type ValidateResult struct {
	Valid   bool
	Code    RefusalCode
	Message string
}

// ValidateDataDir applies the four D-08 refusal rules in order:
//
//  1. non-ASCII / non-NFC (cheap; runs first)
//  2. parent directory missing
//  3. nested-vault detection
//  4. write probe (mkdir 0700 + create+remove a tempfile)
//
// The rules are short-circuit: the first that fires returns immediately.
// A "valid" result means the path can be used as the data-dir without
// any further check — RunSetup re-runs ValidateDataDir as a final gate
// to defend against a client that bypasses the debounced /validate-data-dir
// call.
//
// Threat model:
//   - T-08-06 (Tampering): handled by RunSetup re-validation, not here.
//   - T-08-07 (DoS): top-of-function path-length cap at 4096 bytes
//     bounds the work done per request before any filesystem syscall.
//   - T-08-09 (info disclosure): we deliberately surface the underlying
//     os.Error message for the unwritable case because the UI needs
//     actionable remediation. The user is local-host and already
//     controls the filesystem; risk accepted.
func ValidateDataDir(path string) ValidateResult {
	// T-08-07 mitigation: path-length cap. Returns the non-ASCII refusal
	// code because oversized paths usually carry junk; the locked copy
	// is the closest match to "your path is bad, fix it" without adding
	// a new refusal code (which would require an openapi.yaml change).
	if len(path) > maxDataDirPathLen {
		return ValidateResult{Code: RefusalNonASCII, Message: msgNonASCII}
	}

	// D-08d: non-ASCII / non-NFC chars. Run this FIRST — pure-in-memory
	// work, no syscall, so a hostile client can't cause filesystem load
	// with a deliberately-bad path.
	//
	// Two checks: norm.NFC.IsNormalString catches decomposed forms
	// (e.g. NFD "é" rendered as "e" + U+0301) that survive a casual
	// ASCII-only scan; the unicode.MaxASCII range loop catches any
	// codepoint outside 0x00..0x7F.
	if !norm.NFC.IsNormalString(path) {
		return ValidateResult{Code: RefusalNonASCII, Message: msgNonASCII}
	}
	for _, r := range path {
		if r > unicode.MaxASCII {
			return ValidateResult{Code: RefusalNonASCII, Message: msgNonASCII}
		}
	}

	// D-08a: parent directory must exist. We require the user to create
	// the parent themselves (D-08 design: never silently create more
	// than one level — that hides typos like /Documnets/Jasper).
	parent := filepath.Dir(path)
	if _, err := os.Stat(parent); errors.Is(err, fs.ErrNotExist) {
		return ValidateResult{Code: RefusalParentMissing, Message: msgParentMissing}
	}

	// D-08b: nested-vault detection. Walk parents looking for an existing
	// Jasper layout (a sibling pair of `notes/` and `storage/app.db`).
	// If any ancestor matches AND we are strictly nested under it,
	// refuse — preventing the user from accidentally turning a vault
	// inside another vault.
	if isInsideExistingVault(path) {
		return ValidateResult{Code: RefusalNestedVault, Message: msgNestedVault}
	}

	// D-08c: write probe. We create the dir if missing (the wizard is
	// allowed to materialize a path the user picked); then we open and
	// remove a tempfile. Both steps must succeed — mkdir alone isn't
	// sufficient (a folder can be mkdir-able but immutable on some
	// hostile mount configurations).
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

// isInsideExistingVault walks parents of path; if any STRICT ancestor
// contains both `notes/` (dir) AND `storage/app.db` (file), the input
// path is inside an existing Jasper vault and must be rejected.
//
// Strict-ancestor semantics: a vault's own root is NOT "inside itself".
// We exit the walk at the filesystem root (when filepath.Dir(p) == p).
func isInsideExistingVault(path string) bool {
	// Start the walk one level above the input — checking only strict
	// ancestors. If path itself happens to look like a vault root we
	// don't refuse it here (the write probe + first-run wizard owns
	// that case via "this folder already has notes" UX in a later
	// plan; D-08b is specifically the nesting rule).
	cur := filepath.Dir(path)
	for {
		parent := filepath.Dir(cur)
		if parent == cur {
			// reached filesystem root with no vault found
			return false
		}
		if isDir(filepath.Join(parent, "notes")) && fileExists(filepath.Join(parent, "storage", "app.db")) {
			return true
		}
		cur = parent
	}
}

// isDir reports whether p exists and is a directory. Returns false on
// any stat error (not-exist, permission, I/O) — the caller treats
// "can't tell" as "not a vault" because the write-probe rule below
// will catch genuine permission problems with a more useful refusal
// code.
func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

// fileExists reports whether p exists and is accessible. Returns false
// for any stat error (same rationale as isDir).
func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
