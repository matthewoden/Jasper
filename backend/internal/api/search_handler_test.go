package api

import "testing"

// TestSearchHandler — Plan 07-04 lands the SearchNotes handler. Covers:
// - happy path with bm25 + recency sort
// - tag-filter AND combination (D-05)
// - excerpt_html with <mark> tags from snippet()
// - FTS5 syntax error → 400 (Pitfall 2)
// - empty query (< 2 chars) is handled by client; server returns empty array if reached
// SCAFFOLD ONLY — implemented in Plan 07-04.
func TestSearchHandler(t *testing.T) {
	t.Skip("scaffold — implemented in Plan 07-04 (search handler)")
}
