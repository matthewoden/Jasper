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
)

// maxDataDirPathLen caps the wizard's data-dir input at 4096 bytes
// BEFORE any os.Stat / NFC walk runs. Threat T-08-07 (RESEARCH §Security
// row "Wizard data-dir DoS via huge path probe"): a hostile or
// accidentally-pasted path of MB-scale length would otherwise drive
// the unicode walk and norm.NFC.IsNormalString through O(len) work
// per request. 4096 is comfortably above any plausible legitimate
// path (PATH_MAX on macOS is 1024; Linux is 4096).
const maxDataDirPathLen = 4096

// RefusalCode names one of the five D-08 refusal cases or "" when
// the validation passes. The wire format (api.SetupValidateResponseCode)
// uses the same string constants — so the handler in setup_handler.go
// can cast directly.
type RefusalCode string

// The five D-08 refusal codes. Strings match openapi.yaml's
// SetupValidateResponseCode enum (generated as
// api.SetupValidateResponseCode constants ParentMissing, NestedVault,
// Unwritable, NonAscii, NotAbsolute).
//
// `not_absolute` was added in the Phase 08 UAT-1 fix
// (debug session firstrun-tilde-not-expanded, 2026-05-18): when the
// user types a relative path (e.g. "Jasper/notes") that ResolveDataDir
// cannot normalise into an absolute path against $HOME, the wizard
// refuses with this code rather than silently materialising a stray
// directory under the binary's launch CWD. Tilde-prefixed paths
// (`~`, `~/...`) are NOT relative — they are resolved against
// os.UserHomeDir() before this check runs, so the common
// `~/Documents/Jasper` case lands cleanly on the Valid path.
const (
	RefusalParentMissing RefusalCode = "parent_missing"
	RefusalNestedVault   RefusalCode = "nested_vault"
	RefusalUnwritable    RefusalCode = "unwritable"
	RefusalNonASCII      RefusalCode = "non_ascii"
	RefusalNotAbsolute   RefusalCode = "not_absolute"
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
	// not_absolute: surfaced when the user enters a relative path that
	// can't be tilde-expanded. The placeholder copy in the wizard input
	// (DataDirSection.tsx) is `~/Documents/Jasper` so the typical happy
	// path is "user types `~`-prefixed → backend resolves → validates".
	// This message points the user at the same shape.
	msgNotAbsolute = "Pick an absolute path (starts with `/`) or a path beginning with `~/`."
)

// ValidateResult is the outcome of ValidateDataDir. Valid is true ONLY
// when none of the D-08 rules fires; otherwise Code carries the
// machine-readable rule name and Message carries the locked UI string.
type ValidateResult struct {
	Valid   bool
	Code    RefusalCode
	Message string
}

// ResolveDataDir normalises a wizard-supplied data-dir path into an
// absolute filesystem path BEFORE any other validation runs. Two
// transforms are applied, in order:
//
//  1. Tilde expansion. A bare "~" or a "~/..." prefix is rewritten
//     against os.UserHomeDir(). The shell convention "~user" (expand
//     against another user's home) is NOT supported — those forms are
//     treated as relative and fall through to the absolute-path check.
//     This matches what users will plausibly type into the wizard input
//     whose placeholder is `~/Documents/Jasper`.
//
//  2. Absolute-path enforcement. After expansion the path MUST be
//     filepath.IsAbs() — otherwise sqlite.Open will reject it later
//     with a confusing "dbPath must be absolute" error, and the
//     write-probe step in ValidateDataDir will silently create a
//     stray directory tree under the binary's launch CWD (the symptom
//     that motivated this helper; see debug
//     firstrun-tilde-not-expanded.md).
//
// On success returns (resolved, "", "") — the resolved path is what
// callers should persist into cfg.Server.DataDir / pass to MkdirAll /
// hand to sqlite.Open. On failure returns ("", code, locked message)
// matching ValidateResult's Code/Message fields exactly.
//
// This function does NO filesystem I/O. It is safe to call from any
// goroutine, and ValidateDataDir + RunSetup both call it.
func ResolveDataDir(raw string) (string, RefusalCode, string) {
	// Tilde expansion. Allowed forms: "~", "~/", "~/anything".
	// Disallowed: "~user", "~user/...". The disallowed forms fall
	// through unchanged and the absolute-path check below catches them.
	expanded := raw
	if raw == "~" || strings.HasPrefix(raw, "~/") {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			// Very rare on macOS / WSL; the runtime has no notion of
			// $HOME for some reason. Surface as not_absolute so the UI
			// renders a useful hint rather than failing silently.
			return "", RefusalNotAbsolute, msgNotAbsolute
		}
		if raw == "~" {
			expanded = home
		} else {
			// "~/<rest>": join home with the rest. filepath.Join
			// normalises duplicate slashes and trailing dots so the
			// result is clean.
			expanded = filepath.Join(home, raw[2:])
		}
	}

	if !filepath.IsAbs(expanded) {
		return "", RefusalNotAbsolute, msgNotAbsolute
	}
	// filepath.Clean tidies up things like "/tmp//foo/./bar" into
	// "/tmp/foo/bar" so the rest of the pipeline (and the persisted
	// config.json) sees a canonical form.
	return filepath.Clean(expanded), "", ""
}

// ValidateDataDir applies the D-08 refusal rules in order:
//
//  0. tilde-expand + absolute-path check (ResolveDataDir; new in
//     UAT-1 fix — prevents the write-probe from creating a stray "~"
//     directory under the binary's launch CWD).
//  1. non-ASCII / non-NFC (cheap; runs on the resolved path)
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

	// D-08e (UAT-1 fix): tilde-expand and refuse non-absolute paths
	// BEFORE any filesystem syscall. This must come before the write
	// probe — otherwise a relative path like "~/Documents/Jasper" would
	// be MkdirAll'd verbatim under the binary's launch CWD, creating
	// a literal "~" tree (the symptom motivating this rule).
	resolved, refusalCode, refusalMsg := ResolveDataDir(path)
	if refusalCode != "" {
		return ValidateResult{Code: refusalCode, Message: refusalMsg}
	}
	path = resolved

	// D-08d: non-ASCII / non-NFC chars. Run this FIRST among the
	// "examine the path string" checks — pure-in-memory work, no
	// syscall, so a hostile client can't cause filesystem load with
	// a deliberately-bad path.
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
