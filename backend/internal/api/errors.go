package api

// newError constructs the api.Error wire shape (matches openapi.yaml
// Error schema: {code, message}).
//
// handlers.go inlines the per-route error mapping (404 vs 500) because each
// strict-server response type is distinct (e.g., GetNoteById404JSONResponse
// vs PutNoteById404JSONResponse) and a generic helper would have to return
// `any`. Keeping the constructor here so the wire shape lives in one place
// is cheap; the per-route translation lives at the call site.
func newError(code, message string) Error {
	return Error{Code: code, Message: message}
}
