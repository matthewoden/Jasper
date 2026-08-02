package workspace

// EventWorkspaceChanged is duplicated from wshub/envelope.go because wshub
// imports notes, so nothing below it can import wshub without a cycle. Must
// stay in sync with the WSEnvelope.event enum in api/openapi.yaml.
const EventWorkspaceChanged = "workspace:changed"
