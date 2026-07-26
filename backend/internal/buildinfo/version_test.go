package buildinfo

import "testing"

// TestVersionNonEmpty pins that Version always has a value — if a future
// refactor blanks it, the About pane would silently render an empty
// appVersion row instead of failing a test.
func TestVersionNonEmpty(t *testing.T) {
	if Version == "" {
		t.Fatal("buildinfo.Version is empty; want a non-empty version string")
	}
}
