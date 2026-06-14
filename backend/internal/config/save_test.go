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
			"vimMode": false,
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
