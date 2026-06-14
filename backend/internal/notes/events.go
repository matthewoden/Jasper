package notes

// Event-type strings — mirrored from backend/internal/wshub/envelope.go.
// Both files MUST stay in sync with api/openapi.yaml's
// components.schemas.WSEnvelope.event enum.
//
// Why duplicated: wshub imports notes (for the Broadcaster compile-time
// assertion in wshub/assert.go); notes cannot import wshub without a
// cycle. The duplication is one-directional and tested by the OpenAPI
// drift gate (make gen-check).
const (
	EventSessionAssigned = "session:assigned"
	EventNoteCreated     = "note:created"
	EventNoteUpdated     = "note:updated"
	EventNoteDeleted     = "note:deleted"
	EventNoteMoved       = "note:moved"
	EventFolderCreated   = "folder:created"
	EventFolderDeleted   = "folder:deleted"
	EventFolderMoved     = "folder:moved"
	EventTagsUpdated     = "tags:updated"
	EventReindexStarted  = "reindex:started"
	EventReindexComplete = "reindex:complete"
	EventMigrationStatus = "migration:status"
	EventTagsRewritten   = "tags:rewritten"  // cross-vault tag rename/delete batch event
	EventLinksRewritten  = "links:rewritten" // cross-vault wiki-link rename batch event
)
