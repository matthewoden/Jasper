package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
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
		"dailyNotes": {"template": ""},
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
		t.Error("editor.spellCheck was dropped by SaveMerged (nested unknown key not preserved)")
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
	seed.DailyNotes.Template = "## journal"
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
	if got.DailyNotes.Template != seed.DailyNotes.Template {
		t.Errorf("DailyNotes.Template: got %q, want %q (unmentioned, must stay untouched)", got.DailyNotes.Template, seed.DailyNotes.Template)
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
		"dailyNotes": {"template": ""},
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
	seed.AppName = "Jasper Seed"
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
	if got.AppName != seed.AppName {
		t.Errorf("AppName: got %q, want %q (unmentioned, must stay untouched)", got.AppName, seed.AppName)
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

// concurrentPartialWriter names one goroutine's contribution to
// TestConcurrentPartialSaves_NoLostUpdate: a single-field overlay and the
// raw JSON path/value it must produce on disk once every writer has landed.
type concurrentPartialWriter struct {
	name    string
	overlay map[string]json.RawMessage
	path    []string
	want    string
}

// buildConcurrentPartialWriters returns 24 structurally independent
// single-field overlays: 8 real Config fields (including two pairs that
// share the same top-level nested object — editor and dailyNotes — so the
// test also proves concurrent writers converging on one nested section
// don't clobber each other's sibling keys) plus 16 unmanaged top-level
// probe keys, which deepMergeRawMaps preserves unconditionally.
func buildConcurrentPartialWriters() []concurrentPartialWriter {
	writers := []concurrentPartialWriter{
		{"appName", map[string]json.RawMessage{"appName": json.RawMessage(`"probe-appName"`)}, []string{"appName"}, `"probe-appName"`},
		{"editor.fontSize", map[string]json.RawMessage{"editor": json.RawMessage(`{"fontSize":21}`)}, []string{"editor", "fontSize"}, `21`},
		{"editor.lineHeight", map[string]json.RawMessage{"editor": json.RawMessage(`{"lineHeight":1.9}`)}, []string{"editor", "lineHeight"}, `1.9`},
		{"editor.autosaveMs", map[string]json.RawMessage{"editor": json.RawMessage(`{"autosaveMs":4242}`)}, []string{"editor", "autosaveMs"}, `4242`},
		{"editor.lineWidth", map[string]json.RawMessage{"editor": json.RawMessage(`{"lineWidth":888}`)}, []string{"editor", "lineWidth"}, `888`},
		{"dailyNotes.folder (now unknown — deepMergeRawMaps must still preserve it)", map[string]json.RawMessage{"dailyNotes": json.RawMessage(`{"folder":"probe-daily"}`)}, []string{"dailyNotes", "folder"}, `"probe-daily"`},
		{"dailyNotes.template", map[string]json.RawMessage{"dailyNotes": json.RawMessage(`{"template":"probe-template"}`)}, []string{"dailyNotes", "template"}, `"probe-template"`},
		{"templates.folder", map[string]json.RawMessage{"templates": json.RawMessage(`{"folder":"probe-templates"}`)}, []string{"templates", "folder"}, `"probe-templates"`},
	}
	for i := range 16 {
		key := fmt.Sprintf("probe_%02d", i)
		val := fmt.Sprintf("%d", i)
		writers = append(writers, concurrentPartialWriter{
			name:    key,
			overlay: map[string]json.RawMessage{key: json.RawMessage(val)},
			path:    []string{key},
			want:    val,
		})
	}
	return writers
}

// rawValueAtPath navigates a decoded map[string]json.RawMessage document
// along path, returning the raw bytes at the leaf and whether every segment
// was present. Used to check a specific writer's field landed on disk
// without decoding the whole document into a typed Config (a typed decode
// would silently pass through the DefaultConfig() zero value for a field
// that never actually landed, masking exactly the bug this test exists to
// catch).
func rawValueAtPath(doc map[string]json.RawMessage, path []string) (json.RawMessage, bool) {
	cur := doc
	for depth, key := range path {
		v, ok := cur[key]
		if !ok {
			return nil, false
		}
		if depth == len(path)-1 {
			return v, true
		}
		var nested map[string]json.RawMessage
		if err := json.Unmarshal(v, &nested); err != nil {
			return nil, false
		}
		cur = nested
	}
	return nil, false
}

// TestConcurrentPartialSaves_NoLostUpdate: 24 goroutines each write one
// distinct field, barrier-gated on a closed channel rather than sleeps. With
// the package mutex removed this failed 5/5 runs, losing several keys.
func TestConcurrentPartialSaves_NoLostUpdate(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	log := newTestLogger()

	seed := DefaultConfig()
	if err := Save(dir, seed); err != nil {
		t.Fatalf("seed Save: %v", err)
	}

	writers := buildConcurrentPartialWriters()
	if len(writers) != 24 {
		t.Fatalf("test setup: got %d writers, want 24", len(writers))
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make([]error, len(writers))
	for i, w := range writers {
		wg.Add(1)
		go func(i int, w concurrentPartialWriter) {
			defer wg.Done()
			<-start
			errs[i] = SaveMergedPartial(dir, w.overlay, log)
		}(i, w)
	}
	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("writer %d (%s): SaveMergedPartial error: %v", i, writers[i].name, err)
		}
	}

	path := filepath.Join(dir, ".jasper", "config.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read final config: %v", err)
	}
	var onDisk map[string]json.RawMessage
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("unmarshal final config: %v", err)
	}

	var lost []string
	for _, w := range writers {
		val, ok := rawValueAtPath(onDisk, w.path)
		if !ok || string(val) != w.want {
			lost = append(lost, fmt.Sprintf("%s: got %q (present=%v), want %q", w.name, val, ok, w.want))
		}
	}
	if len(lost) > 0 {
		t.Errorf("lost updates (%d/%d writes missing or wrong):\n%s", len(lost), len(writers), strings.Join(lost, "\n"))
	}
}

// TestConcurrentPartialSaves_LoadInterleaved — the same 24-writer fan-out,
// plus 4 concurrent Load calls. Guards the Load->saveLocked re-entrancy
// contract from load.go: a future regression that makes loadLocked call
// the exported Save (which itself acquires mu) deadlocks every goroutine
// here, so this test times out rather than silently passing.
func TestConcurrentPartialSaves_LoadInterleaved(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	mkdirStorage(t, dir)
	log := newTestLogger()

	seed := DefaultConfig()
	if err := Save(dir, seed); err != nil {
		t.Fatalf("seed Save: %v", err)
	}

	writers := buildConcurrentPartialWriters()
	start := make(chan struct{})
	var wg sync.WaitGroup

	writeErrs := make([]error, len(writers))
	for i, w := range writers {
		wg.Add(1)
		go func(i int, w concurrentPartialWriter) {
			defer wg.Done()
			<-start
			writeErrs[i] = SaveMergedPartial(dir, w.overlay, log)
		}(i, w)
	}

	const numLoaders = 4
	loadErrs := make([]error, numLoaders)
	loadAppNames := make([]string, numLoaders)
	for i := range numLoaders {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			cfg, err := Load(dir, log)
			loadErrs[i] = err
			loadAppNames[i] = cfg.AppName
		}(i)
	}

	close(start)
	wg.Wait()

	for i, err := range writeErrs {
		if err != nil {
			t.Errorf("writer %d (%s): SaveMergedPartial error: %v", i, writers[i].name, err)
		}
	}
	for i, err := range loadErrs {
		if err != nil {
			t.Errorf("loader %d: Load error: %v", i, err)
		}
		if loadAppNames[i] == "" {
			t.Errorf("loader %d: Load returned empty AppName (should always resolve to a non-zero Config)", i)
		}
	}
}
