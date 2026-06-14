package config

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
)

// Save writes c to <dataDir>/.jasper/config.json atomically via
// fsstore.AtomicWrite (temp+rename+fsync(parent)).
// Indented JSON so a human can `cat` the file and read it.
//
// Caller is responsible for ensuring <dataDir>/.jasper exists.
// lifecycle.EnsureDataDir creates it during boot.
func Save(dataDir string, c Config) error {
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

// SaveMerged reads the raw on-disk JSON, overlays the managed keys from
// updates onto it (preserving any unmanaged/unknown keys), and writes back
// atomically. This prevents a PUT /config round-trip from dropping keys
// added by hand or by a newer binary version.
//
// Load intentionally uses DisallowUnknownFields — this function does NOT
// relax that. Load is the read-path; SaveMerged is write-path only.
//
// Algorithm:
//  1. Read existing disk JSON into map[string]json.RawMessage (best-effort).
//  2. Marshal updates to JSON, decode into overlay map.
//  3. Deep-merge: for nested object keys (editor, dailyNotes, server, mcp)
//     unknown sub-keys from existing are preserved; overlay wins on conflicts.
//     Top-level unknown keys are also preserved (unchanged from before).
//  4. MarshalIndent merged map and AtomicWrite to disk.
func SaveMerged(dataDir string, updates Config, log *slog.Logger) error {
	existing := map[string]json.RawMessage{}
	if raw, err := os.ReadFile(configPath(dataDir)); err == nil {
		if err := json.Unmarshal(raw, &existing); err != nil {
			log.Warn("SaveMerged: could not parse existing config; starting from scratch",
				"err", err)
			existing = map[string]json.RawMessage{}
		}
	}

	managed, err := json.Marshal(updates)
	if err != nil {
		return fmt.Errorf("config marshal: %w", err)
	}

	var overlay map[string]json.RawMessage
	if err := json.Unmarshal(managed, &overlay); err != nil {
		return fmt.Errorf("config overlay parse: %w", err)
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
