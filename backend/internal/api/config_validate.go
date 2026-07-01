package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// ConfigStrictBodyMiddleware is a chi-compatible HTTP middleware that
// enforces strict JSON decoding on PUT /config request bodies.
//
// The oapi-codegen strict-server uses json.NewDecoder without
// DisallowUnknownFields, so unknown keys would otherwise be silently
// accepted. This middleware reads the raw body, validates it with a
// strict decoder, and returns 400 if:
//   - The JSON has unknown fields (additionalProperties: false)
//   - The theme value is not in the enum [dark, light]
//   - A nested object (dailyNotes, editor) has unknown fields
//
// The raw body bytes are restored on r.Body so the downstream strict
// handler can decode them normally.
//
// Usage: mount in the /api/v1 chi sub-router before HandlerFromMux:
//
//	r.Route("/api/v1", func(r chi.Router) {
//	    r.Use(api.ConfigStrictBodyMiddleware)
//	    api.HandlerFromMux(si, r)
//	})
func ConfigStrictBodyMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

		r.Body = io.NopCloser(bytes.NewReader(raw))

		var tmp strictConfigValidator
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&tmp); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"request body contains unknown or invalid fields"}`))
			return
		}

		if tmp.Theme != "dark" && tmp.Theme != "light" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"theme must be one of: dark, light"}`))
			return
		}

		if len(tmp.AppName) < 1 || len(tmp.AppName) > 64 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"appName must be 1–64 chars"}`))
			return
		}
		if len(tmp.DailyNotes.Folder) < 1 || len(tmp.DailyNotes.Folder) > 64 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"dailyNotes.folder must be 1–64 chars"}`))
			return
		}
		if len(tmp.DailyNotes.Template) > 1024 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"dailyNotes.template must be at most 1024 chars"}`))
			return
		}
		if tmp.Editor.FontSize < 8 || tmp.Editor.FontSize > 32 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"editor.fontSize must be 8–32"}`))
			return
		}
		if tmp.Editor.LineHeight < 1.0 || tmp.Editor.LineHeight > 3.0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"editor.lineHeight must be 1.0–3.0"}`))
			return
		}
		if tmp.Editor.AutosaveMs < 250 || tmp.Editor.AutosaveMs > 10000 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"editor.autosaveMs must be 250–10000"}`))
			return
		}
		if tmp.DisplayName != nil && len(*tmp.DisplayName) > 64 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"display_name must be at most 64 chars"}`))
			return
		}
		if tmp.Accent != nil {
			switch *tmp.Accent {
			case "purple", "sky", "green", "orange":
			default:
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"code":"invalid_request","message":"accent must be one of: purple, sky, green, orange"}`))
				return
			}
		}
		if tmp.ReadingFont != nil {
			switch *tmp.ReadingFont {
			case "sans", "serif":
			default:
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"code":"invalid_request","message":"readingFont must be one of: sans, serif"}`))
				return
			}
		}

		next.ServeHTTP(w, r)
	})
}

type strictConfigValidator struct {
	AppName     string  `json:"appName"`
	DisplayName *string `json:"display_name,omitempty"`
	Theme       string  `json:"theme"`
	Accent      *string `json:"accent,omitempty"`
	ReadingFont *string `json:"readingFont,omitempty"`
	DailyNotes  struct {
		Folder   string `json:"folder"`
		Template string `json:"template"`
	} `json:"dailyNotes"`
	Editor struct {
		FontSize   int     `json:"fontSize"`
		LineHeight float64 `json:"lineHeight"`
		VimMode    bool    `json:"vimMode"`
		AutosaveMs int     `json:"autosaveMs"`
	} `json:"editor"`
	Server *struct {
		Port    int    `json:"port"`
		DataDir string `json:"dataDir"`
		Bind    string `json:"bind"`
	} `json:"server,omitempty"`
	Mcp *struct {
		Enabled bool   `json:"enabled"`
		Port    int    `json:"port"`
		Bind    string `json:"bind"`
	} `json:"mcp,omitempty"`
}
