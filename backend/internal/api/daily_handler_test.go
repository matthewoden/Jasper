package api

import "testing"

// TestDailyNotesHandler — Plan 07-05 lands the GetDailyNote handler. Covers:
// - first call: creates from template, returns 201, indexer.Upsert called
// - second call: returns 200 with existing row
// - invalid date format → 400
// - {{date}} template substitution
// - frontmatter scaffold prepended (D-43)
// - concurrent get-or-create race (Pitfall 6)
// SCAFFOLD ONLY — implemented in Plan 07-05.
func TestDailyNotesHandler(t *testing.T) {
	t.Skip("scaffold — implemented in Plan 07-05 (daily notes handler)")
}
