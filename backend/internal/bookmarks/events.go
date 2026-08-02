package bookmarks

// EventBookmarkChanged is duplicated from wshub/envelope.go because wshub
// imports notes, so nothing below it can import wshub without a cycle. Must
// stay in sync with the WSEnvelope.event enum in api/openapi.yaml.
const EventBookmarkChanged = "bookmark:changed"
