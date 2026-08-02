package config

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sync"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
)

// mu serialises every exported read/write against config.json.
// A plain Mutex, not RWMutex: Load's first-run branch writes the default
// config, so it must be able to reach the write path without releasing and
// re-acquiring the lock. An RWMutex's RLock->Lock is neither reentrant nor
// upgradable and would deadlock there; every exported function instead
// delegates to an unexported *Locked helper that assumes mu is already held.
var mu sync.Mutex

// Save writes c to <dataDir>/.jasper/config.json atomically via
// fsstore.AtomicWrite (temp+rename+fsync(parent)).
// Indented JSON so a human can `cat` the file and read it.
//
// Caller is responsible for ensuring <dataDir>/.jasper exists.
// lifecycle.EnsureDataDir creates it during boot.
func Save(dataDir string, c Config) error {
	mu.Lock()
	defer mu.Unlock()
	return saveLocked(dataDir, c)
}

// saveLocked is Save's body, callable from other functions in this package
// that already hold mu (e.g. loadLocked's first-run default emit). Never
// call this without mu held, and never have it acquire mu itself.
func saveLocked(dataDir string, c Config) error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("config marshal: %w", err)
	}
	if err := fsstore.AtomicWrite(configPath(dataDir), data); err != nil {
		return fmt.Errorf("config save: %w", err)
	}
	return nil
}

// deepMergeRawMaps merges overlay into base, returning the result.
// For keys present in both maps where both values are JSON objects,
// the merge recurses so that unknown sub-keys in base are preserved
// and overlay wins on conflicts. For all other value types (arrays,
// scalars, null) the overlay value replaces base entirely (same
// behaviour as the old flat merge).
//
// This is used by SaveMerged so unknown or hand-added keys inside managed
// nested objects (e.g. editor.spellCheck) survive a PUT /config round-trip.
func deepMergeRawMaps(base, overlay map[string]json.RawMessage) map[string]json.RawMessage {
	for k, v := range overlay {
		if baseVal, ok := base[k]; ok {
			// Both values exist — attempt nested merge if both are JSON objects.
			var bMap, oMap map[string]json.RawMessage
			if json.Unmarshal(baseVal, &bMap) == nil && json.Unmarshal(v, &oMap) == nil {
				// Both are objects: recurse and re-marshal.
				merged := deepMergeRawMaps(bMap, oMap)
				if data, err := json.Marshal(merged); err == nil {
					base[k] = data
					continue
				}
			}
		}
		// Scalar, array, null, or one side is not an object — overlay wins.
		base[k] = v
	}
	return base
}

// SaveMerged overlays the managed keys onto the raw on-disk JSON, preserving
// unmanaged/unknown keys at every nesting level, so a PUT /config round-trip
// cannot drop keys added by hand or by a newer binary.
func SaveMerged(dataDir string, updates Config, log *slog.Logger) error {
	mu.Lock()
	defer mu.Unlock()

	managed, err := json.Marshal(updates)
	if err != nil {
		return fmt.Errorf("config marshal: %w", err)
	}

	var overlay map[string]json.RawMessage
	if err := json.Unmarshal(managed, &overlay); err != nil {
		return fmt.Errorf("config overlay parse: %w", err)
	}

	return saveMergedRawLocked(dataDir, overlay, log)
}

// SaveMergedPartial reads the raw on-disk JSON and overlays only the keys
// present in overlay (a sparse PATCH body), preserving every key overlay
// does not mention — including managed keys not sent in this request and
// unknown/hand-added keys. A key present in overlay is always applied
// (including "", 0, false); absence from the map is the only thing that
// means "leave untouched".
func SaveMergedPartial(dataDir string, overlay map[string]json.RawMessage, log *slog.Logger) error {
	mu.Lock()
	defer mu.Unlock()
	return saveMergedRawLocked(dataDir, overlay, log)
}

// saveMergedRawLocked performs the read -> deep-merge -> atomic-write
// sequence shared by SaveMerged and SaveMergedPartial. The whole sequence
// must run inside one critical section — locking only around AtomicWrite
// would relocate the lost-update race instead of closing it. Never call
// this without mu held, and never have it acquire mu itself.
func saveMergedRawLocked(dataDir string, overlay map[string]json.RawMessage, log *slog.Logger) error {
	existing := map[string]json.RawMessage{}
	if raw, err := os.ReadFile(configPath(dataDir)); err == nil {
		if err := json.Unmarshal(raw, &existing); err != nil {
			log.Warn("SaveMerged: could not parse existing config; starting from scratch",
				"err", err)
			existing = map[string]json.RawMessage{}
		}
	}

	existing = deepMergeRawMaps(existing, overlay)

	merged, err := json.MarshalIndent(existing, "", "  ")
	if err != nil {
		return fmt.Errorf("config merge marshal: %w", err)
	}

	if err := fsstore.AtomicWrite(configPath(dataDir), merged); err != nil {
		return fmt.Errorf("config save merged: %w", err)
	}
	return nil
}
