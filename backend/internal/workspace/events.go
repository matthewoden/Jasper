package workspace

// EventWorkspaceChanged is mirrored from wshub/envelope.go — see
// backend/internal/bookmarks/events.go for the same precedent-established
// duplication. Both files MUST stay in sync with api/openapi.yaml's
// components.schemas.WSEnvelope.event enum.
//
// Why duplicated: wshub imports notes (for the Broadcaster compile-time
// assertion in wshub/assert.go); notes cannot import wshub without a
// cycle. workspace follows the same layering, so it cannot import wshub
// either. The duplication is one-directional and tested by the OpenAPI
// drift gate (make gen-check).
const EventWorkspaceChanged = "workspace:changed"
