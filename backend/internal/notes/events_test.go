package notes

import "testing"

func TestNotes_EventConstants(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		got  string
		want string
	}{
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
