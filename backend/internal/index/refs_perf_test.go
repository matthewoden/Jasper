package index

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Criterion 12: backlinks for one target over 200k refs rows (10k notes x 20
// refs) answer in under 10 ms. The rows are inserted directly; what is
// measured is the lookup.
func TestRefBacklinks_200kRows_Under10ms(t *testing.T) {
	if testing.Short() {
		t.Skip("volume test")
	}
	t.Parallel()
	idx, _ := newTestIndexer(t)
	ctx := context.Background()

	const notesN, refsPer = 10_000, 20
	tx, err := idx.Pair.BeginImmediate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	noteStmt, _ := tx.PrepareContext(ctx, `INSERT INTO notes(id, path, title, mtime_unix, size_bytes, checksum_sha256, created_at, updated_at) VALUES (?, ?, ?, ?, 0, '', 1, 1)`)
	refStmt, _ := tx.PrepareContext(ctx, `INSERT INTO refs(source_id, target_ref, display, position, embed) VALUES (?, ?, '', 0, 0)`)
	for i := 0; i < notesN; i++ {
		id := notes.NewID().String()
		if _, err := noteStmt.ExecContext(ctx, id, fmt.Sprintf("n/%05d.md", i), fmt.Sprintf("Note %d", i), int64(i)); err != nil {
			t.Fatal(err)
		}
		for r := 0; r < refsPer; r++ {
			target := fmt.Sprintf("ado:workitem/%d", (i*7+r*13)%(notesN*10)+1)
			if _, err := refStmt.ExecContext(ctx, id, target); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	// Warm once, then time the lookups a cold cache would see across targets.
	if _, err := idx.RefBacklinks(ctx, "ado:workitem/1"); err != nil {
		t.Fatal(err)
	}
	var worst time.Duration
	for k := 1; k <= 50; k++ {
		target := fmt.Sprintf("ado:workitem/%d", k*997%(notesN*10)+1)
		start := time.Now()
		if _, err := idx.RefBacklinks(ctx, target); err != nil {
			t.Fatal(err)
		}
		if d := time.Since(start); d > worst {
			worst = d
		}
	}
	t.Logf("worst RefBacklinks over 200k rows: %s", worst)
	if worst > 10*time.Millisecond {
		t.Errorf("RefBacklinks took %s, want under 10ms", worst)
	}
}
