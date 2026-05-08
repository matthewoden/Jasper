package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// ConfigStrictBodyMiddleware is a chi-compatible HTTP middleware that
// enforces strict JSON decoding (D-40) on PUT /config request bodies.
//
// The oapi-codegen strict-server uses json.NewDecoder without
// DisallowUnknownFields, so unknown keys would otherwise be silently
// accepted. This middleware reads the raw body, validates it with a
// strict decoder, and returns 400 if:
//   - The JSON has unknown fields (additionalProperties: false, T-05-03-02)
//   - The theme value is not in the enum [dark, light] (T-05-03-03)
//   - A nested object (dailyNotes, editor) has unknown fields
//
// The raw body bytes are restored on r.Body so the downstream strict
// handler can decode them normally.
//
// Usage: mount in the /api/v1 chi sub-router before HandlerFromMux (both
// app.go Phase-1-shape and lifecycle.go full-wiring paths):
//
//	r.Route("/api/v1", func(r chi.Router) {
//	    r.Use(api.ConfigStrictBodyMiddleware)
//	    api.HandlerFromMux(si, r)
//	})
func ConfigStrictBodyMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only intercept PUT /config (or any path ending in /config).
		// All other routes pass through without body inspection.
		if r.Method != http.MethodPut || !strings.HasSuffix(r.URL.Path, "/config") {
			next.ServeHTTP(w, r)
			return
		}

		raw, err := io.ReadAll(r.Body)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"could not read request body"}`))
			return
		}
		// Restore body for downstream handlers.
		r.Body = io.NopCloser(bytes.NewReader(raw))

		// Strict decode with DisallowUnknownFields (D-40).
		// We decode into a custom validator struct that mirrors the Config
		// shape so we can check the enum without importing generated types
		// (this file is in the same package, so we use Config directly).
		var tmp strictConfigValidator
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&tmp); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"request body contains unknown or invalid fields"}`))
			return
		}

		// Enum check for theme (D-40, T-05-03-03).
		if tmp.Theme != "dark" && tmp.Theme != "light" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"theme must be one of: dark, light"}`))
			return
		}

		next.ServeHTTP(w, r)
	})
}

// strictConfigValidator mirrors the Config schema for strict decoding.
// Fields must match api.Config's JSON tags exactly — any drift here is
// caught at test time (TestPutConfig_RoundTrip decodes the echoed body
// back into api.Config, ensuring field alignment).
//
// DailyNotes and Editor are inline structs to match the generated
// anonymous-struct shapes in openapi_gen.go.
type strictConfigValidator struct {
	AppName    string `json:"appName"`
	Theme      string `json:"theme"`
	DailyNotes struct {
		Folder   string `json:"folder"`
		Template string `json:"template"`
	} `json:"dailyNotes"`
	Editor struct {
		FontSize   int     `json:"fontSize"`
		LineHeight float64 `json:"lineHeight"`
		VimMode    bool    `json:"vimMode"`
	} `json:"editor"`
}
