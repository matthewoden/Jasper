package migrate

import (
	"context"
	"testing"
)

func TestMarker_RecordThenRead(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	pair := newTestPair(t, t.TempDir())
	if _, err := pair.Writer.ExecContext(ctx,
		`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}

	if done, err := Marker(ctx, pair.Writer, "007_x_complete"); err != nil || done {
		t.Fatalf("Marker before record = %v, %v; want false", done, err)
	}
	if err := RecordMarker(ctx, pair.Writer, "007_x_complete"); err != nil {
		t.Fatalf("RecordMarker: %v", err)
	}
	if done, err := Marker(ctx, pair.Writer, "007_x_complete"); err != nil || !done {
		t.Fatalf("Marker after record = %v, %v; want true", done, err)
	}
	if done, _ := Marker(ctx, pair.Writer, "008_other"); done {
		t.Errorf("an unrecorded marker reads as done")
	}
}
