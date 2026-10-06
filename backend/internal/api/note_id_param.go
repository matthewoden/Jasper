package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Mount registers the generated routes on r. Note ids are plain strings on the
// wire, so the shape check the UUID binder used to perform lives here instead:
// a malformed `{id}` on a note route is a 400 before any handler runs.
func Mount(si ServerInterface, r chi.Router) http.Handler {
	return HandlerWithOptions(si, ChiServerOptions{
		BaseRouter:  r,
		Middlewares: []MiddlewareFunc{requireNoteID},
	})
}

func requireNoteID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rctx := chi.RouteContext(r.Context())
		if rctx != nil && strings.Contains(rctx.RoutePattern(), "/notes/{id}") {
			if _, err := notes.ParseID(chi.URLParam(r, "id")); err != nil {
				http.Error(w, "Invalid format for parameter id: "+err.Error(), http.StatusBadRequest)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
