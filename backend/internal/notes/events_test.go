package notes

// TestNotes_EventConstants guards the duplication contract between
// backend/internal/notes/events.go, backend/internal/wshub/envelope.go,
// and api/openapi.yaml's WSEnvelope.event enum.
//
// If a constant string changes here without updating the other two files
// the test will still pass — but the drift gate (make gen-check) will
// catch the openapi.yaml → envelope.go divergence. Together, these two
// gates ensure the contract is self-documenting and machine-checked.
//
// Plan 06-02 Task 2 (TDD): this test is the RED gate that verifies the
// two new Phase 6 constants exist with the correct wire strings.
import "testing"

func TestNotes_EventConstants(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		got  string
		want string
	}{
		// Existing constants — regression guard.
		{"EventSessionAssigned", EventSessionAssigned, "session:assigned"},
		{"EventNoteCreated", EventNoteCreated, "note:created"},
		{"EventNoteUpdated", EventNoteUpdated, "note:updated"},
		{"EventNoteDeleted", EventNoteDeleted, "note:deleted"},
		{"EventNoteMoved", EventNoteMoved, "note:moved"},
		{"EventFolderCreated", EventFolderCreated, "folder:created"},
		{"EventFolderDeleted", EventFolderDeleted, "folder:deleted"},
		{"EventFolderMoved", EventFolderMoved, "folder:moved"},
		{"EventTagsUpdated", EventTagsUpdated, "tags:updated"},
		{"EventReindexStarted", EventReindexStarted, "reindex:started"},
		{"EventReindexComplete", EventReindexComplete, "reindex:complete"},
		{"EventMigrationStatus", EventMigrationStatus, "migration:status"},
		// Phase 6 additions — the two constants that expand the contract.
		{"EventTagsRewritten", EventTagsRewritten, "tags:rewritten"},
		{"EventLinksRewritten", EventLinksRewritten, "links:rewritten"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.want {
				t.Errorf("%s = %q, want %q", tc.name, tc.got, tc.want)
			}
		})
	}
}
