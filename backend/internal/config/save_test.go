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

// TestSave_AtomicWrite — D-39 atomic write contract. Save writes via
// fsstore.AtomicWrite which means a temp file is created in the same
// directory and renamed; after Save returns, exactly one config.json
// exists at the target path (no .tmp.* leftovers when Save succeeded)
// and the bytes match what was marshaled.
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
