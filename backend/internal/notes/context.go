package notes

import "context"

// ctxKey is a private type for context keys in the notes package.
// Using a named type prevents collisions with other packages' context keys.
type ctxKey int

const sessionIDKey ctxKey = 0

// WithSessionID returns ctx with the given X-Session-ID stored. Used
// by the chi middleware in app/middleware.go (app imports notes, not
// the other way around — no import cycle).
func WithSessionID(ctx context.Context, sid string) context.Context {
	return context.WithValue(ctx, sessionIDKey, sid)
}

// SessionIDFromContext returns the X-Session-ID extracted by the chi
// middleware, or "" if absent (server-originated request, curl, or
// test). Empty disables the broadcast filter — every connected client
// (including the originator) sees the event.
func SessionIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(sessionIDKey).(string); ok {
		return v
	}
	return ""
}
