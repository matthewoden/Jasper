package firstrun

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

func TestValidateDataDir_Valid(t *testing.T) {
	t.Parallel()

	base := t.TempDir()
	target := filepath.Join(base, "Jasper")
	res := ValidateDataDir(target)
	if !res.Valid {
		t.Fatalf("expected Valid=true; got Code=%q Message=%q", res.Code, res.Message)
	}
	if res.Code != "" || res.Message != "" {
		t.Fatalf("expected zero refusal fields on valid result; got Code=%q Message=%q", res.Code, res.Message)
	}
}

func TestValidateDataDir_ParentMissing(t *testing.T) {
	t.Parallel()

	base := t.TempDir()
	target := filepath.Join(base, "no-such-parent-12345", "Jasper")
	res := ValidateDataDir(target)
	if res.Valid {
		t.Fatalf("expected Valid=false; got Valid=true")
	}
	if res.Code != RefusalParentMissing {
		t.Fatalf("Code: got %q want %q", res.Code, RefusalParentMissing)
	}
	if !strings.Contains(res.Message, "parent folder doesn't exist") {
		t.Fatalf("Message missing locked phrase: got %q", res.Message)
	}

	if res.Message != msgParentMissing {
		t.Fatalf("Message drift from locked copy:\n got: %q\nwant: %q", res.Message, msgParentMissing)
	}
}

func TestValidateDataDir_NestedVault(t *testing.T) {
	t.Parallel()

	base := t.TempDir()
	vaultDir := filepath.Join(base, "vault")
	if err := os.MkdirAll(filepath.Join(vaultDir, "notes"), 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(vaultDir, vault.SubdirName), 0o755); err != nil {
		t.Fatalf("mkdir .jasper: %v", err)
	}
	if err := os.WriteFile(vault.AppDBPath(vaultDir), []byte("fake"), 0o600); err != nil {
		t.Fatalf("write app.db: %v", err)
	}

	subfolder := filepath.Join(vaultDir, "subfolder")
	if err := os.MkdirAll(subfolder, 0o755); err != nil {
		t.Fatalf("mkdir subfolder: %v", err)
	}
	target := filepath.Join(subfolder, "Jasper")
	res := ValidateDataDir(target)
	if res.Valid {
		t.Fatalf("expected Valid=false; got Valid=true (target=%q)", target)
	}
	if res.Code != RefusalNestedVault {
		t.Fatalf("Code: got %q want %q", res.Code, RefusalNestedVault)
	}
	if !strings.Contains(res.Message, "inside an existing Jasper vault") {
		t.Fatalf("Message missing locked phrase: got %q", res.Message)
	}
	if res.Message != msgNestedVault {
		t.Fatalf("Message drift from locked copy:\n got: %q\nwant: %q", res.Message, msgNestedVault)
	}
}

func TestValidateDataDir_Unwritable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping unwritable check on windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("skipping unwritable check as root (root bypasses 0o000)")
	}
	t.Parallel()

	base := t.TempDir()
	unwritableParent := filepath.Join(base, "ro")
	if err := os.MkdirAll(unwritableParent, 0o755); err != nil {
		t.Fatalf("mkdir ro: %v", err)
	}

	if err := os.Chmod(unwritableParent, 0o500); err != nil {
		t.Fatalf("chmod 0500: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chmod(unwritableParent, 0o755)
	})

	target := filepath.Join(unwritableParent, "Jasper")
	res := ValidateDataDir(target)
	if res.Valid {
		t.Fatalf("expected Valid=false; got Valid=true (target=%q)", target)
	}
	if res.Code != RefusalUnwritable {
		t.Fatalf("Code: got %q want %q (msg=%q)", res.Code, RefusalUnwritable, res.Message)
	}
	if !strings.HasPrefix(res.Message, "Jasper can't write here:") {
		t.Fatalf("Message missing locked prefix: got %q", res.Message)
	}
	if !strings.HasSuffix(res.Message, "Check folder permissions.") {
		t.Fatalf("Message missing locked suffix: got %q", res.Message)
	}
}

func TestValidateDataDir_NonASCII(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		path string
	}{
		{name: "NFC é", path: "/tmp/Documents/Jasper-é"},
		{name: "NFD e+combining-acute", path: "/tmp/Documents/Jasper-é"},
		{name: "CJK chars", path: "/tmp/筆記"},
		{name: "emoji", path: "/tmp/jasper-🚀"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			res := ValidateDataDir(tc.path)
			if res.Valid {
				t.Fatalf("expected Valid=false for non-ASCII path %q; got Valid=true", tc.path)
			}
			if res.Code != RefusalNonASCII {
				t.Fatalf("Code: got %q want %q", res.Code, RefusalNonASCII)
			}
			if !strings.Contains(res.Message, "don't survive cross-platform sync") {
				t.Fatalf("Message missing locked phrase: got %q", res.Message)
			}
			if res.Message != msgNonASCII {
				t.Fatalf("Message drift from locked copy:\n got: %q\nwant: %q", res.Message, msgNonASCII)
			}
		})
	}
}

// TestValidateDataDir_PathTooLong covers T-08-07 DoS mitigation —
// oversized paths short-circuit before any syscall runs.
func TestValidateDataDir_PathTooLong(t *testing.T) {
	t.Parallel()
	huge := strings.Repeat("a", maxDataDirPathLen+1)
	res := ValidateDataDir(huge)
	if res.Valid {
		t.Fatalf("expected Valid=false for oversized path; got Valid=true")
	}
	if res.Code != RefusalNonASCII {
		t.Fatalf("Code: got %q want %q (oversized path mapped to NonASCII per T-08-07)", res.Code, RefusalNonASCII)
	}
}

// TestResolveDataDir_TildeExpansion covers the UAT-1 fix
// (debug firstrun-tilde-not-expanded.md): bare "~" and "~/..." paths
// must expand against os.UserHomeDir() into absolute paths. Without
// this, sqlite.Open at the end of RunSetup rejects the resulting
// dbPath with "dbPath must be absolute" and the wizard fails after
// the user has already committed.
func TestResolveDataDir_TildeExpansion(t *testing.T) {
	t.Parallel()
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("os.UserHomeDir empty/err — skipping (rare env)")
	}

	cases := []struct {
		name string
		in   string
		want string
	}{
		{"bare_tilde", "~", home},
		{"tilde_slash", "~/", home},
		{"tilde_subdir", "~/Documents/Jasper", filepath.Join(home, "Documents/Jasper")},
		{"tilde_deep", "~/a/b/c", filepath.Join(home, "a/b/c")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, code, msg := ResolveDataDir(tc.in)
			if code != "" {
				t.Fatalf("expected success; got code=%q msg=%q", code, msg)
			}
			if got != tc.want {
				t.Fatalf("resolved path:\n got: %q\nwant: %q", got, tc.want)
			}
			if !filepath.IsAbs(got) {
				t.Fatalf("resolved path %q is not absolute — sqlite.Open will reject it", got)
			}
		})
	}
}

// TestResolveDataDir_AbsolutePassthrough verifies that an already-
// absolute path (the common /tmp/foo case used by tests) survives
// ResolveDataDir unchanged after filepath.Clean.
func TestResolveDataDir_AbsolutePassthrough(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   string
		want string
	}{
		{"/tmp/Jasper", "/tmp/Jasper"},
		{"/tmp//Jasper//", "/tmp/Jasper"},
		{"/tmp/./Jasper", "/tmp/Jasper"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			t.Parallel()
			got, code, msg := ResolveDataDir(tc.in)
			if code != "" {
				t.Fatalf("expected success; got code=%q msg=%q", code, msg)
			}
			if got != tc.want {
				t.Fatalf("resolved path:\n got: %q\nwant: %q", got, tc.want)
			}
		})
	}
}

// TestResolveDataDir_NotAbsolute covers the new not_absolute refusal
// code: a relative path (no leading "/" and no expandable "~/" prefix)
// must be refused before the write probe runs. "~user" forms (NOT
// supported) also fall into this bucket.
func TestResolveDataDir_NotAbsolute(t *testing.T) {
	t.Parallel()
	cases := []string{
		"Documents/Jasper",
		"./Jasper",
		"../Jasper",
		"~someuser/Jasper",
		"~someuser",
		"",
	}
	for _, in := range cases {
		in := in
		t.Run(in, func(t *testing.T) {
			t.Parallel()
			got, code, msg := ResolveDataDir(in)
			if code != RefusalNotAbsolute {
				t.Fatalf("got code=%q want %q (in=%q got=%q)", code, RefusalNotAbsolute, in, got)
			}
			if msg != msgNotAbsolute {
				t.Fatalf("Message drift:\n got: %q\nwant: %q", msg, msgNotAbsolute)
			}
		})
	}
}

// TestValidateDataDir_TildePath_NoStrayDir is the integration check
// tying ResolveDataDir into ValidateDataDir. A "~/..." path passed
// through ValidateDataDir must NOT create a stray "~"-rooted directory
// under the test runner's cwd — that was the original symptom of the
// bug fixed in debug session firstrun-tilde-not-expanded.md.
//
// We snapshot cwd, check whether a literal "./~" already exists (so
// we don't false-positive on leftover artifacts), call ValidateDataDir
// on a tilded path, and then assert that no stray "./~" appeared.
func TestValidateDataDir_TildePath_NoStrayDir(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	strayPath := filepath.Join(cwd, "~")

	preExists := false
	if _, err := os.Stat(strayPath); err == nil {
		preExists = true
	}

	_ = ValidateDataDir("~/jasper-tilde-test-zzz-08-uat1")

	if !preExists {
		if _, err := os.Stat(strayPath); err == nil {
			_ = os.RemoveAll(strayPath)
			t.Fatalf("ValidateDataDir created stray literal-tilde dir at %q — tilde expansion did not run", strayPath)
		}
	}
}
