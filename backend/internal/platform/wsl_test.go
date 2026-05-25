package platform

import (
	"os"
	"path/filepath"
	"testing"
)

// IsWSL is exercised via the OsreleasePath override so the unit test works on
// any host (macOS CI included) by feeding it fixture content.
func TestIsWSL_DetectsMicrosoftSubstring(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{"WSL2 typical", "5.15.167.4-microsoft-standard-WSL2", true},
		{"WSL2 uppercase", "5.15.0-MICROSOFT-WSL2", true},
		{"native Linux", "5.10.0-21-amd64", false},
		{"empty file", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			f := filepath.Join(dir, "osrelease")
			if err := os.WriteFile(f, []byte(tt.content), 0o644); err != nil {
				t.Fatalf("write fixture: %v", err)
			}
			orig := OsreleasePath
			OsreleasePath = f
			defer func() { OsreleasePath = orig }()

			if got := IsWSL(); got != tt.want {
				t.Errorf("IsWSL() with %q: got %v, want %v", tt.content, got, tt.want)
			}
		})
	}
}

func TestIsWSL_MissingFile_ReturnsFalse(t *testing.T) {
	orig := OsreleasePath
	OsreleasePath = filepath.Join(t.TempDir(), "does-not-exist")
	defer func() { OsreleasePath = orig }()

	if IsWSL() {
		t.Errorf("IsWSL() with missing file: got true, want false")
	}
}

func TestWslToWindows(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		// /mnt/<drive> cases — happy path.
		{"/mnt/c", `C:\`},
		{"/mnt/c/", `C:\`},
		{"/mnt/c/Users", `C:\Users`},
		{"/mnt/c/Users/you", `C:\Users\you`},
		{"/mnt/c/Users/you/Documents", `C:\Users\you\Documents`},
		{"/mnt/c/Users/you/Documents/", `C:\Users\you\Documents`},
		{"/mnt/d/Code/Jasper", `D:\Code\Jasper`},

		// No Windows equivalent — these correctly return "".
		{"/home/me/Documents", ""},
		{"/root", ""},
		{"/", ""},
		{"", ""},
		{"relative/path", ""},
		// /mnt itself isn't a drive — not a Windows path.
		{"/mnt", ""},
		{"/mnt/", ""},
		// Multi-character "drive" shouldn't match — WSL uses single-letter mounts.
		{"/mnt/usbdrive/x", ""},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := WslToWindows(tt.in); got != tt.want {
				t.Errorf("WslToWindows(%q): got %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
