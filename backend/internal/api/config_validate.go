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
		if (r.Method != http.MethodPut && r.Method != http.MethodPatch) || !strings.HasSuffix(r.URL.Path, "/config") {
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

		if r.Method == http.MethodPatch {
			validateConfigPatchBody(w, raw, next, r)
			return
		}

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
		if tmp.Editor.LineWidth != nil && (*tmp.Editor.LineWidth < 400 || *tmp.Editor.LineWidth > 2000) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"editor.lineWidth must be 400–2000"}`))
			return
		}
		if tmp.Templates != nil && len(tmp.Templates.Folder) > 64 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"templates.folder must be at most 64 chars"}`))
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
	Theme       string  `json:"theme"`
	Accent      *string `json:"accent,omitempty"`
	ReadingFont *string `json:"readingFont,omitempty"`
	DailyNotes  struct {
		Folder   string `json:"folder"`
		Template string `json:"template"`
	} `json:"dailyNotes"`
	Editor struct {
		FontSize       int     `json:"fontSize"`
		LineHeight     float64 `json:"lineHeight"`
		AutosaveMs     int     `json:"autosaveMs"`
		ShowProperties *bool   `json:"showProperties,omitempty"`
		AutoPair       *bool   `json:"autoPair,omitempty"`
		FoldGutter     *bool   `json:"foldGutter,omitempty"`
		LineNumbers    *bool   `json:"lineNumbers,omitempty"`
		LineWidth      *int    `json:"lineWidth,omitempty"`
	} `json:"editor"`
	Server *struct {
		Port    int    `json:"port"`
		DataDir string `json:"dataDir"`
		Bind    string `json:"bind"`
	} `json:"server,omitempty"`
	Mcp *struct {
		Port     int    `json:"port"`
		Bind     string `json:"bind"`
		AuditLog *bool  `json:"auditLog,omitempty"`
	} `json:"mcp,omitempty"`
	Templates *struct {
		Folder string `json:"folder"`
	} `json:"templates,omitempty"`
}

// strictConfigPatchValidator is strictConfigValidator's PATCH counterpart:
// every field (including the ones required on PUT) is an optional pointer.
// Reusing the value-typed strictConfigValidator here would read an omitted
// field (e.g. fontSize) as its Go zero value and reject a legitimate
// "don't touch fontSize" patch — presence, not requiredness, is what PATCH
// validates. JSON tag names match strictConfigValidator's exactly.
type strictConfigPatchValidator struct {
	AppName     *string `json:"appName,omitempty"`
	Theme       *string `json:"theme,omitempty"`
	Accent      *string `json:"accent,omitempty"`
	ReadingFont *string `json:"readingFont,omitempty"`
	DailyNotes  *struct {
		Folder   *string `json:"folder,omitempty"`
		Template *string `json:"template,omitempty"`
	} `json:"dailyNotes,omitempty"`
	Editor *struct {
		FontSize       *int     `json:"fontSize,omitempty"`
		LineHeight     *float64 `json:"lineHeight,omitempty"`
		AutosaveMs     *int     `json:"autosaveMs,omitempty"`
		ShowProperties *bool    `json:"showProperties,omitempty"`
		AutoPair       *bool    `json:"autoPair,omitempty"`
		FoldGutter     *bool    `json:"foldGutter,omitempty"`
		LineNumbers    *bool    `json:"lineNumbers,omitempty"`
		LineWidth      *int     `json:"lineWidth,omitempty"`
	} `json:"editor,omitempty"`
	Server *struct {
		Port    *int    `json:"port,omitempty"`
		DataDir *string `json:"dataDir,omitempty"`
		Bind    *string `json:"bind,omitempty"`
	} `json:"server,omitempty"`
	Mcp *struct {
		Port     *int    `json:"port,omitempty"`
		Bind     *string `json:"bind,omitempty"`
		AuditLog *bool   `json:"auditLog,omitempty"`
	} `json:"mcp,omitempty"`
	Templates *struct {
		Folder *string `json:"folder,omitempty"`
	} `json:"templates,omitempty"`
}

// validateConfigPatchBody decodes raw against strictConfigPatchValidator and
// applies the same eleven constraints as the PUT block, wrapped in the
// non-nil guards the sparse shape requires. An absent field is never an
// error; a present zero value (e.g. dailyNotes.template: "") always passes,
// because clearing a field is a legitimate write, not an omission.
func validateConfigPatchBody(w http.ResponseWriter, raw []byte, next http.Handler, r *http.Request) {
	var tmp strictConfigPatchValidator
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&tmp); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"invalid_request","message":"request body contains unknown or invalid fields"}`))
		return
	}

	if tmp.Theme != nil && *tmp.Theme != "dark" && *tmp.Theme != "light" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"invalid_request","message":"theme must be one of: dark, light"}`))
		return
	}
	if tmp.AppName != nil && (len(*tmp.AppName) < 1 || len(*tmp.AppName) > 64) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"invalid_request","message":"appName must be 1–64 chars"}`))
		return
	}
	if tmp.DailyNotes != nil && tmp.DailyNotes.Folder != nil &&
		(len(*tmp.DailyNotes.Folder) < 1 || len(*tmp.DailyNotes.Folder) > 64) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"invalid_request","message":"dailyNotes.folder must be 1–64 chars"}`))
		return
	}
	if tmp.DailyNotes != nil && tmp.DailyNotes.Template != nil && len(*tmp.DailyNotes.Template) > 1024 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"invalid_request","message":"dailyNotes.template must be at most 1024 chars"}`))
		return
	}
	if tmp.Editor != nil && tmp.Editor.FontSize != nil && (*tmp.Editor.FontSize < 8 || *tmp.Editor.FontSize > 32) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"invalid_request","message":"editor.fontSize must be 8–32"}`))
		return
	}
	if tmp.Editor != nil && tmp.Editor.LineHeight != nil && (*tmp.Editor.LineHeight < 1.0 || *tmp.Editor.LineHeight > 3.0) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"invalid_request","message":"editor.lineHeight must be 1.0–3.0"}`))
		return
	}
	if tmp.Editor != nil && tmp.Editor.AutosaveMs != nil && (*tmp.Editor.AutosaveMs < 250 || *tmp.Editor.AutosaveMs > 10000) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"invalid_request","message":"editor.autosaveMs must be 250–10000"}`))
		return
	}
	if tmp.Editor != nil && tmp.Editor.LineWidth != nil && (*tmp.Editor.LineWidth < 400 || *tmp.Editor.LineWidth > 2000) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"invalid_request","message":"editor.lineWidth must be 400–2000"}`))
		return
	}
	if tmp.Templates != nil && tmp.Templates.Folder != nil && len(*tmp.Templates.Folder) > 64 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"invalid_request","message":"templates.folder must be at most 64 chars"}`))
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
}
