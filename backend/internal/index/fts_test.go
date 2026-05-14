package index

import "testing"

// TestFTS5Migration — Plan 07-02 lands the 003_fts.sql migration; this test verifies
// the FTS5 virtual table exists, the columns body_fts/tag_names_fts exist on `notes`,
// and the rebuild command can be invoked. SCAFFOLD ONLY — implemented in Plan 07-02.
func TestFTS5Migration(t *testing.T) {
	t.Skip("scaffold — implemented in Plan 07-02 (FTS5 migration)")
}

// TestFTSUpsertSync — Plan 07-03 lands the indexer FTS sync hook; this test verifies
// that Upsert/Delete keep notes_fts in lockstep with notes. SCAFFOLD ONLY.
func TestFTSUpsertSync(t *testing.T) {
	t.Skip("scaffold — implemented in Plan 07-03 (indexer FTS sync)")
}

// TestFTSDivergenceRebuild — Plan 07-03 startup divergence check rebuilds notes_fts
// when row counts disagree. SCAFFOLD ONLY.
func TestFTSDivergenceRebuild(t *testing.T) {
	t.Skip("scaffold — implemented in Plan 07-03 (startup divergence check)")
}
