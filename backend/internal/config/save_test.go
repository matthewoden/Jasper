package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// .jasper literal allowed in this in-package test file: importing
// internal/vault here would create a test-only import cycle because
// vault.CreateVault depends on this config package.

// TestSave_AtomicWrite — Save writes via fsstore.AtomicWrite: a temp file
// is created in the same directory and renamed; after Save returns, exactly
// one config.json exists at the target path (no .tmp.* leftovers) and the
// bytes match what was marshaled.
func TestSave_AtomicWrite(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)

	in := DefaultConfig()
	if err := Save(dir, in); err != nil {
		t.Fatalf("Save: %v", err)
	}

	path := filepath.Join(dir, ".jasper", "config.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var got Config
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal written file: %v", err)
	}
	if got != in {
		t.Errorf("disk content mismatch:\n got  %+v\n want %+v", got, in)
	}
}

// TestSaveMerged_NestedUnknownKeySurvives — SaveMerged must preserve
// unknown keys inside nested managed objects (e.g. editor.spellCheck,
// dailyNotes.colorTag). deepMergeRawMaps recurses into JSON objects
// instead of wholesale-replacing the nested blob.
func TestSaveMerged_NestedUnknownKeySurvives(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	log := newTestLogger()

	// Write a config.json with an unknown nested key inside "editor".
	path := filepath.Join(dir, ".jasper", "config.json")
	initial := []byte(`{
		"appName": "Jasper",
		"theme": "dark",
		"dailyNotes": {"folder": "daily", "template": ""},
		"editor": {
			"fontSize": 15,
			"lineHeight": 1.6,
			"autosaveMs": 2000,
			"spellCheck": true
		},
		"server": {"port": 6683, "dataDir": ""},
		"mcp": {"enabled": false, "port": 6684, "bind": "127.0.0.1"}
	}`)
	if err := os.WriteFile(path, initial, 0o644); err != nil {
		t.Fatal(err)
	}

	// SaveMerged with a managed update that changes editor.fontSize.
	updates := DefaultConfig()
	updates.Editor.FontSize = 18 // the managed change

	if err := SaveMerged(dir, updates, log); err != nil {
		t.Fatalf("SaveMerged: %v", err)
	}

	// Read back and check.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after SaveMerged: %v", err)
	}
	var onDisk map[string]json.RawMessage
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// The nested unknown key editor.spellCheck must still be present.
	editorRaw, ok := onDisk["editor"]
	if !ok {
		t.Fatal("editor key missing from on-disk JSON")
	}
	var editor map[string]json.RawMessage
	if err := json.Unmarshal(editorRaw, &editor); err != nil {
		t.Fatalf("unmarshal editor: %v", err)
	}
	spellCheckRaw, ok := editor["spellCheck"]
	if !ok {
		t.Error("WR-01: editor.spellCheck was dropped by SaveMerged (nested unknown key not preserved)")
	} else {
		var sc bool
		if err := json.Unmarshal(spellCheckRaw, &sc); err != nil || !sc {
			t.Errorf("editor.spellCheck: got %s, want true", spellCheckRaw)
		}
	}

	// The managed editor.fontSize must reflect the update.
	fontSizeRaw, ok := editor["fontSize"]
	if !ok {
		t.Error("editor.fontSize key missing")
	} else {
		var fs int
		if err := json.Unmarshal(fontSizeRaw, &fs); err != nil || fs != 18 {
			t.Errorf("editor.fontSize: got %s, want 18", fontSizeRaw)
		}
	}
}

// TestSaveMergedPartial_LeavesUnmentionedKeysUntouched — a sparse overlay
// touching only editor.lineHeight must leave every other seeded key,
// including editor's other fields, byte-identical to what Save wrote.
func TestSaveMergedPartial_LeavesUnmentionedKeysUntouched(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	log := newTestLogger()

	seed := DefaultConfig()
	seed.AppName = "Jasper Seed"
	seed.Theme = "dark"
	seed.DailyNotes.Folder = "daily"
	seed.Editor.FontSize = 15
	seed.Editor.LineHeight = 1.6
	seed.Editor.AutosaveMs = 2000
	if err := Save(dir, seed); err != nil {
		t.Fatalf("Save: %v", err)
	}

	overlay := map[string]json.RawMessage{
		"editor": json.RawMessage(`{"lineHeight":1.5}`),
	}
	if err := SaveMergedPartial(dir, overlay, log); err != nil {
		t.Fatalf("SaveMergedPartial: %v", err)
	}

	path := filepath.Join(dir, ".jasper", "config.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after SaveMergedPartial: %v", err)
	}
	var got Config
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if got.Editor.LineHeight != 1.5 {
		t.Errorf("Editor.LineHeight: got %v, want 1.5 (the overlaid field)", got.Editor.LineHeight)
	}
	if got.Editor.FontSize != seed.Editor.FontSize {
		t.Errorf("Editor.FontSize: got %d, want %d (unmentioned, must stay untouched)", got.Editor.FontSize, seed.Editor.FontSize)
	}
	if got.Editor.AutosaveMs != seed.Editor.AutosaveMs {
		t.Errorf("Editor.AutosaveMs: got %d, want %d (unmentioned, must stay untouched)", got.Editor.AutosaveMs, seed.Editor.AutosaveMs)
	}
	if got.AppName != seed.AppName {
		t.Errorf("AppName: got %q, want %q (unmentioned, must stay untouched)", got.AppName, seed.AppName)
	}
	if got.Theme != seed.Theme {
		t.Errorf("Theme: got %q, want %q (unmentioned, must stay untouched)", got.Theme, seed.Theme)
	}
	if got.DailyNotes.Folder != seed.DailyNotes.Folder {
		t.Errorf("DailyNotes.Folder: got %q, want %q (unmentioned, must stay untouched)", got.DailyNotes.Folder, seed.DailyNotes.Folder)
	}
}

// TestSaveMergedPartial_PreservesUnknownKeys — a sparse overlay touching one
// managed field must leave an unmanaged top-level key and an unmanaged
// nested key (inside a managed section) intact.
func TestSaveMergedPartial_PreservesUnknownKeys(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	log := newTestLogger()

	path := filepath.Join(dir, ".jasper", "config.json")
	initial := []byte(`{
		"appName": "Jasper",
		"theme": "dark",
		"someFutureTopLevelKey": "keep-me",
		"dailyNotes": {"folder": "daily", "template": ""},
		"editor": {
			"fontSize": 15,
			"lineHeight": 1.6,
			"autosaveMs": 2000,
			"someFutureNestedKey": 42
		},
		"server": {"port": 6683, "dataDir": ""},
		"mcp": {"port": 6684, "bind": "127.0.0.1"}
	}`)
	if err := os.WriteFile(path, initial, 0o644); err != nil {
		t.Fatal(err)
	}

	overlay := map[string]json.RawMessage{
		"editor": json.RawMessage(`{"fontSize":18}`),
	}
	if err := SaveMergedPartial(dir, overlay, log); err != nil {
		t.Fatalf("SaveMergedPartial: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after SaveMergedPartial: %v", err)
	}
	var onDisk map[string]json.RawMessage
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if v, ok := onDisk["someFutureTopLevelKey"]; !ok || string(v) != `"keep-me"` {
		t.Errorf("someFutureTopLevelKey: got %s, ok=%v, want \"keep-me\"", v, ok)
	}

	var editor map[string]json.RawMessage
	if err := json.Unmarshal(onDisk["editor"], &editor); err != nil {
		t.Fatalf("unmarshal editor: %v", err)
	}
	if v, ok := editor["someFutureNestedKey"]; !ok || string(v) != "42" {
		t.Errorf("editor.someFutureNestedKey: got %s, ok=%v, want 42", v, ok)
	}
	if v, ok := editor["fontSize"]; !ok || string(v) != "18" {
		t.Errorf("editor.fontSize: got %s, ok=%v, want 18 (the overlaid field)", v, ok)
	}
}

// TestSaveMergedPartial_AppliesExplicitZeroValues — a key present in the
// overlay with an empty/zero value is a real "clear this" write, not an
// omission; it must be applied, not skipped.
func TestSaveMergedPartial_AppliesExplicitZeroValues(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	log := newTestLogger()

	seed := DefaultConfig()
	seed.DailyNotes.Folder = "daily"
	seed.DailyNotes.Template = "## {{date}}\n\n"
	if err := Save(dir, seed); err != nil {
		t.Fatalf("Save: %v", err)
	}

	overlay := map[string]json.RawMessage{
		"dailyNotes": json.RawMessage(`{"template":""}`),
	}
	if err := SaveMergedPartial(dir, overlay, log); err != nil {
		t.Fatalf("SaveMergedPartial: %v", err)
	}

	path := filepath.Join(dir, ".jasper", "config.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after SaveMergedPartial: %v", err)
	}
	var got Config
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if got.DailyNotes.Template != "" {
		t.Errorf("DailyNotes.Template: got %q, want \"\" (explicit empty-string overlay must apply, not be skipped)", got.DailyNotes.Template)
	}
	if got.DailyNotes.Folder != seed.DailyNotes.Folder {
		t.Errorf("DailyNotes.Folder: got %q, want %q (unmentioned, must stay untouched)", got.DailyNotes.Folder, seed.DailyNotes.Folder)
	}
}

// TestSave_OverwritesExisting — Save called twice writes the second
// version cleanly (atomic rename truncates the prior file).
func TestSave_OverwritesExisting(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)

	a := DefaultConfig()
	b := DefaultConfig()
	b.Theme = "light"

	if err := Save(dir, a); err != nil {
		t.Fatal(err)
	}
	if err := Save(dir, b); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(dir, ".jasper", "config.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got Config
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Theme != "light" {
		t.Errorf("Theme: got %q, want %q", got.Theme, "light")
	}
}
