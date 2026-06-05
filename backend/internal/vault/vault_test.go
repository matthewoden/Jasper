// Package vault tests cover V8–V12, V15 from 08-CONTEXT.md.
// All tests use t.TempDir() + t.Setenv("JASPER_APP_HOME", …) to redirect
// the loader/saver away from the real ~/.jasper directory.
package vault

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// TestCanonicalize_AbsRequired verifies that a relative path returns an error.
func TestCanonicalize_AbsRequired(t *testing.T) {
	_, err := Canonicalize("relative/path")
	if err == nil {
		t.Fatal("expected error for relative path, got nil")
	}
}

// TestCanonicalize_EmptyPath verifies that an empty path returns an error.
func TestCanonicalize_EmptyPath(t *testing.T) {
	_, err := Canonicalize("")
	if err == nil {
		t.Fatal("expected error for empty path, got nil")
	}
}

// TestCanonicalize_TrailingSlashCollapses verifies that "/x/y/" and "/x/y"
// canonicalize to the same value.
func TestCanonicalize_TrailingSlashCollapses(t *testing.T) {
	dir := t.TempDir()
	withSlash := dir + "/"
	withoutSlash := dir

	a, err := Canonicalize(withSlash)
	if err != nil {
		t.Fatalf("Canonicalize(%q): %v", withSlash, err)
	}
	b, err := Canonicalize(withoutSlash)
	if err != nil {
		t.Fatalf("Canonicalize(%q): %v", withoutSlash, err)
	}
	if a != b {
		t.Errorf("trailing slash not collapsed: %q != %q", a, b)
	}
}

// TestCanonicalize_DarwinLowercase verifies that on darwin,
// "/Users/Me/Vault" canonicalizes to "/users/me/vault".
func TestCanonicalize_DarwinLowercase(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("darwin-only test")
	}

	input := "/Users/Me/Vault"
	got, err := Canonicalize(input)
	if err != nil {
		t.Fatalf("Canonicalize(%q): %v", input, err)
	}
	want := "/users/me/vault"
	if got != want {
		t.Errorf("darwin lowercase: want %q, got %q", want, got)
	}
}

// TestCanonicalize_SymlinkResolves verifies that a symlink path resolves to
// the real (target) path.
func TestCanonicalize_SymlinkResolves(t *testing.T) {
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	canonTarget, err := Canonicalize(target)
	if err != nil {
		t.Fatalf("Canonicalize(target): %v", err)
	}
	canonLink, err := Canonicalize(link)
	if err != nil {
		t.Fatalf("Canonicalize(link): %v", err)
	}
	if canonTarget != canonLink {
		t.Errorf("symlink not resolved: target=%q, link=%q", canonTarget, canonLink)
	}
}

// TestCanonicalize_NonexistentPathStillCleans verifies that a non-existent
// abs path returns a Clean(Abs(…)) result without error.
func TestCanonicalize_NonexistentPathStillCleans(t *testing.T) {
	p := "/absolutely/nonexistent/path/for/testing/vault"
	got, err := Canonicalize(p)
	if err != nil {
		t.Fatalf("Canonicalize(%q) returned unexpected error: %v", p, err)
	}
	if got == "" {
		t.Errorf("Canonicalize(%q) returned empty string", p)
	}
}

// TestLoadAppJSON_FileMissingCreatesEmpty verifies that calling LoadAppJSON
// against a missing path returns an empty state AND creates the file.
func TestLoadAppJSON_FileMissingCreatesEmpty(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JASPER_APP_HOME", dir)
	path := filepath.Join(dir, "app.json")

	state, err := LoadAppJSON(path)
	if err != nil {
		t.Fatalf("LoadAppJSON: %v", err)
	}
	if state == nil {
		t.Fatal("state is nil")
	}
	if len(state.RecentVaults) != 0 {
		t.Errorf("want 0 recent vaults, got %d", len(state.RecentVaults))
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("app.json not created on missing-file path: %v", err)
	}
}

// TestLoadAppJSON_ValidJSONRoundTrip verifies that writing a state via
// SaveAppJSON then loading it returns the same 3 entries sorted newest-first.
func TestLoadAppJSON_ValidJSONRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JASPER_APP_HOME", dir)
	path := filepath.Join(dir, "app.json")

	now := time.Now().UTC().Truncate(time.Second)
	state := &AppState{
		CurrentVault: "/vault/a",
		RecentVaults: []RecentVaultEntry{
			{Path: "/vault/a", DisplayName: "a", LastOpenedAt: now.Add(-1 * time.Hour), CreatedAt: now.Add(-24 * time.Hour)},
			{Path: "/vault/b", DisplayName: "b", LastOpenedAt: now.Add(-2 * time.Hour), CreatedAt: now.Add(-48 * time.Hour)},
			{Path: "/vault/c", DisplayName: "c", LastOpenedAt: now, CreatedAt: now.Add(-10 * time.Minute)},
		},
	}
	if err := SaveAppJSON(path, state); err != nil {
		t.Fatalf("SaveAppJSON: %v", err)
	}

	loaded, err := LoadAppJSON(path)
	if err != nil {
		t.Fatalf("LoadAppJSON: %v", err)
	}
	if len(loaded.RecentVaults) != 3 {
		t.Fatalf("want 3 entries, got %d", len(loaded.RecentVaults))
	}

	if loaded.RecentVaults[0].Path != "/vault/c" {
		t.Errorf("want newest first (/vault/c), got %q", loaded.RecentVaults[0].Path)
	}
	if loaded.RecentVaults[2].Path != "/vault/b" {
		t.Errorf("want oldest last (/vault/b), got %q", loaded.RecentVaults[2].Path)
	}
}

// TestLoadAppJSON_CorruptBackupAndReset verifies that a corrupt JSON file
// is backed up as "app.json.corrupt.<ts>" and a fresh empty state is returned.
func TestLoadAppJSON_CorruptBackupAndReset(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JASPER_APP_HOME", dir)
	path := filepath.Join(dir, "app.json")

	if err := os.WriteFile(path, []byte(`{"current_vault": "/x", "recent_vaults": [`), 0o600); err != nil {
		t.Fatalf("write corrupt: %v", err)
	}

	state, err := LoadAppJSON(path)
	if err != nil {
		t.Fatalf("LoadAppJSON should not error on corrupt: %v", err)
	}
	if state == nil {
		t.Fatal("state is nil after corrupt-reset")
	}
	if len(state.RecentVaults) != 0 {
		t.Errorf("want empty after corrupt-reset, got %d entries", len(state.RecentVaults))
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	foundBackup := false
	for _, e := range entries {
		if len(e.Name()) > len("app.json.corrupt.") &&
			e.Name()[:len("app.json.corrupt.")] == "app.json.corrupt." {
			foundBackup = true
			break
		}
	}
	if !foundBackup {
		t.Errorf("no app.json.corrupt.* backup file found in %s", dir)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fresh app.json: %v", err)
	}
	var fresh AppState
	if err := json.Unmarshal(raw, &fresh); err != nil {
		t.Fatalf("parse fresh app.json: %v", err)
	}
	if len(fresh.RecentVaults) != 0 {
		t.Errorf("fresh app.json should have 0 entries, got %d", len(fresh.RecentVaults))
	}
}

// TestLoadAppJSON_MissingFolderMarkedNotDropped verifies that entries whose
// path no longer exists have Missing=true but are NOT dropped.
func TestLoadAppJSON_MissingFolderMarkedNotDropped(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JASPER_APP_HOME", dir)
	path := filepath.Join(dir, "app.json")

	vaultDir := filepath.Join(t.TempDir(), "my-vault")
	if err := os.Mkdir(vaultDir, 0o700); err != nil {
		t.Fatalf("mkdir vault: %v", err)
	}
	now := time.Now().UTC()
	state := &AppState{
		CurrentVault: vaultDir,
		RecentVaults: []RecentVaultEntry{
			{Path: vaultDir, DisplayName: "my-vault", LastOpenedAt: now, CreatedAt: now},
		},
	}
	if err := SaveAppJSON(path, state); err != nil {
		t.Fatalf("SaveAppJSON: %v", err)
	}

	if err := os.Remove(vaultDir); err != nil {
		t.Fatalf("remove vault: %v", err)
	}

	loaded, err := LoadAppJSON(path)
	if err != nil {
		t.Fatalf("LoadAppJSON: %v", err)
	}
	if len(loaded.RecentVaults) != 1 {
		t.Fatalf("want 1 entry, got %d", len(loaded.RecentVaults))
	}
	if !loaded.RecentVaults[0].Missing {
		t.Errorf("entry should be Missing=true after vault dir removed")
	}
}

// TestSaveAppJSON_AtomicWrite verifies no temp files are left behind after
// SaveAppJSON returns.
func TestSaveAppJSON_AtomicWrite(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JASPER_APP_HOME", dir)
	path := filepath.Join(dir, "app.json")

	state := &AppState{RecentVaults: []RecentVaultEntry{}}
	if err := SaveAppJSON(path, state); err != nil {
		t.Fatalf("SaveAppJSON: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if len(e.Name()) > 4 && e.Name()[len(e.Name())-4:] == ".tmp" {
			t.Errorf("temp file left behind: %q", e.Name())
		}

		if filepath.Ext(e.Name()) == ".tmp" {
			t.Errorf("temp file left behind: %q", e.Name())
		}
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read app.json: %v", err)
	}
	var out AppState
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("parse app.json: %v", err)
	}
}

// TestTouchOpened_NewEntryAdded verifies that touching a new path adds it
// and sets CurrentVault.
func TestTouchOpened_NewEntryAdded(t *testing.T) {
	state := &AppState{RecentVaults: []RecentVaultEntry{}}
	TouchOpened(state, "/canonical/a", "a")
	if len(state.RecentVaults) != 1 {
		t.Fatalf("want 1 entry, got %d", len(state.RecentVaults))
	}
	if state.CurrentVault != "/canonical/a" {
		t.Errorf("CurrentVault = %q; want %q", state.CurrentVault, "/canonical/a")
	}
}

// TestTouchOpened_ExistingEntryUpdatesLastOpenedAt verifies that touching an
// existing path updates LastOpenedAt without adding a duplicate.
func TestTouchOpened_ExistingEntryUpdatesLastOpenedAt(t *testing.T) {
	before := time.Now().UTC().Add(-1 * time.Hour)
	state := &AppState{
		RecentVaults: []RecentVaultEntry{
			{Path: "/canonical/a", DisplayName: "a", LastOpenedAt: before, CreatedAt: before},
		},
	}
	time.Sleep(2 * time.Millisecond)
	TouchOpened(state, "/canonical/a", "a")
	if len(state.RecentVaults) != 1 {
		t.Errorf("want 1 entry (no duplicate), got %d", len(state.RecentVaults))
	}
	if !state.RecentVaults[0].LastOpenedAt.After(before) {
		t.Errorf("LastOpenedAt not advanced: before=%v, after=%v", before, state.RecentVaults[0].LastOpenedAt)
	}
}

// TestTouchOpened_LRUEvictsAt11thEntry verifies that adding 11 distinct paths
// results in exactly 10 entries with the oldest evicted.
func TestTouchOpened_LRUEvictsAt11thEntry(t *testing.T) {
	state := &AppState{RecentVaults: []RecentVaultEntry{}}
	firstPath := "/canonical/0"
	TouchOpened(state, firstPath, "0")
	for i := 1; i <= 10; i++ {
		time.Sleep(1 * time.Millisecond)
		p := filepath.Join("/canonical", string(rune('0'+i)))
		TouchOpened(state, p, string(rune('0'+i)))
	}
	if len(state.RecentVaults) != RecentVaultsCap {
		t.Errorf("want %d entries (LRU cap), got %d", RecentVaultsCap, len(state.RecentVaults))
	}

	for _, e := range state.RecentVaults {
		if e.Path == firstPath {
			t.Errorf("first entry %q should have been evicted by LRU", firstPath)
		}
	}
}

// TestForget_RemovesMatchingPath verifies that Forget removes the correct entry.
func TestForget_RemovesMatchingPath(t *testing.T) {
	state := &AppState{
		CurrentVault: "/a",
		RecentVaults: []RecentVaultEntry{
			{Path: "/a", DisplayName: "a"},
			{Path: "/b", DisplayName: "b"},
			{Path: "/c", DisplayName: "c"},
		},
	}
	Forget(state, "/b")
	if len(state.RecentVaults) != 2 {
		t.Errorf("want 2 entries after Forget, got %d", len(state.RecentVaults))
	}
	for _, e := range state.RecentVaults {
		if e.Path == "/b" {
			t.Errorf("/b should have been removed")
		}
	}

	Forget(state, "/nonexistent")
	if len(state.RecentVaults) != 2 {
		t.Errorf("want 2 entries after no-op Forget, got %d", len(state.RecentVaults))
	}
}

// TestForget_ClearsCurrentVaultWhenMatching verifies that Forget clears
// CurrentVault when it matches the forgotten path.
func TestForget_ClearsCurrentVaultWhenMatching(t *testing.T) {
	state := &AppState{
		CurrentVault: "/a",
		RecentVaults: []RecentVaultEntry{
			{Path: "/a", DisplayName: "a"},
		},
	}
	Forget(state, "/a")
	if state.CurrentVault != "" {
		t.Errorf("CurrentVault should be empty after forgetting current, got %q", state.CurrentVault)
	}
}

// TestSaveAppJSON_Atomic_RoundTrip verifies that Save then Load returns
// equivalent state.
func TestSaveAppJSON_Atomic_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JASPER_APP_HOME", dir)
	path := filepath.Join(dir, "app.json")

	now := time.Now().UTC().Truncate(time.Second)
	state := &AppState{
		CurrentVault: "/roundtrip/vault",
		RecentVaults: []RecentVaultEntry{
			{Path: "/roundtrip/vault", DisplayName: "RoundTrip", LastOpenedAt: now, CreatedAt: now},
		},
	}
	if err := SaveAppJSON(path, state); err != nil {
		t.Fatalf("SaveAppJSON: %v", err)
	}
	loaded, err := LoadAppJSON(path)
	if err != nil {
		t.Fatalf("LoadAppJSON: %v", err)
	}
	if loaded.CurrentVault != state.CurrentVault {
		t.Errorf("CurrentVault mismatch: got %q, want %q", loaded.CurrentVault, state.CurrentVault)
	}
	if len(loaded.RecentVaults) != 1 {
		t.Fatalf("want 1 entry, got %d", len(loaded.RecentVaults))
	}
	if loaded.RecentVaults[0].Path != "/roundtrip/vault" {
		t.Errorf("path mismatch: got %q", loaded.RecentVaults[0].Path)
	}
}

// TestSaveAppJSON_ParentDirCreatedWith0700 verifies that SaveAppJSON creates
// missing parent directories with mode 0700.
func TestSaveAppJSON_ParentDirCreatedWith0700(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows mode check skipped")
	}
	base := t.TempDir()
	path := filepath.Join(base, "missing-parent", "sub", "app.json")

	state := &AppState{RecentVaults: []RecentVaultEntry{}}
	if err := SaveAppJSON(path, state); err != nil {
		t.Fatalf("SaveAppJSON: %v", err)
	}

	fi, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("stat parent dir: %v", err)
	}
	if fi.Mode().Perm() != 0o700 {
		t.Errorf("parent dir mode = %04o; want 0700", fi.Mode().Perm())
	}
}

// TestSaveAppJSON_FileMode0600 verifies that the written file has mode 0600.
func TestSaveAppJSON_FileMode0600(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows mode check skipped")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "app.json")

	state := &AppState{RecentVaults: []RecentVaultEntry{}}
	if err := SaveAppJSON(path, state); err != nil {
		t.Fatalf("SaveAppJSON: %v", err)
	}

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("file mode = %04o; want 0600", fi.Mode().Perm())
	}
}
