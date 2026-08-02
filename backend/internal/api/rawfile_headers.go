package api

import (
	"fmt"
	"net/http"
	"strings"
)

// RawFileCSP guards raw vault files. An SVG served as image/svg+xml is also a
// document: opened as a top-level navigation, a <script> inside it runs in the
// app origin with same-origin access to every note. `sandbox` with no allow-
// tokens kills that, and does not affect subresource loads, so embedded images
// still render.
//
// The app-wide script-src 'self' also blocks it today — but that is one
// unrelated CSP relaxation away from being gone. This keeps the guarantee
// attached to the response that needs it.
const RawFileCSP = "default-src 'none'; sandbox"

// IsRawFilePath reports whether p is a route that streams user-controlled
// bytes back out of the vault, and so needs RawFileCSP instead of the app CSP.
//
// Lives here, next to the handlers, so the router does not have to re-encode
// this package's route shapes. The router needs it because the
// oapi-codegen-generated attachment response writes only Content-Type and
// Content-Length and so cannot set headers of its own.
func IsRawFilePath(p string) bool {
	return p == "/api/v1/files" ||
		strings.HasPrefix(p, "/api/v1/files/") ||
		strings.HasPrefix(p, "/api/v1/attachments/")
}

// inlineContentTypes is the allowlist of media that may render inline. SVG is
// present deliberately — notes embed .svg through this endpoint, and RawFileCSP
// is what makes that safe. Everything else (HTML, XML, archives, unknown
// octet-streams) is marked as a download.
var inlineContentTypes = map[string]bool{
	"image/svg+xml":   true,
	"image/png":       true,
	"image/jpeg":      true,
	"image/gif":       true,
	"image/webp":      true,
	"image/avif":      true,
	"image/bmp":       true,
	"image/x-icon":    true,
	"application/pdf": true,
}

// setRawFileSecurityHeaders applies the headers every raw-file response needs.
//
// Set by the handler itself rather than relying solely on the router: ServeFile
// is mounted after HandlerFromMux so chi's last-registration-wins promotes it
// (see the ordering hazard in ADR-0023), and a security header that depends on
// mount order is a security header that will eventually go missing.
func setRawFileSecurityHeaders(h http.Header) {
	h.Set("Content-Security-Policy", RawFileCSP)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "no-referrer")
}

// contentDisposition returns inline for allowlisted media and attachment for
// everything else. Media types carry parameters (e.g. "text/xml; charset=utf-8"),
// so compare on the bare type.
func contentDisposition(contentType, filename string) string {
	base := strings.TrimSpace(strings.ToLower(contentType))
	if i := strings.Index(base, ";"); i >= 0 {
		base = strings.TrimSpace(base[:i])
	}

	if inlineContentTypes[base] || strings.HasPrefix(base, "video/") || strings.HasPrefix(base, "audio/") {
		return "inline"
	}
	return fmt.Sprintf("attachment; filename=%q", sanitizeDispositionFilename(filename))
}

// sanitizeDispositionFilename strips the characters that would let a filename
// break out of the quoted-string form and inject header parameters.
func sanitizeDispositionFilename(name string) string {
	cleaned := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7F || r == '"' || r == '\\' {
			return -1
		}
		return r
	}, name)
	if cleaned == "" {
		return "download"
	}
	return cleaned
}
