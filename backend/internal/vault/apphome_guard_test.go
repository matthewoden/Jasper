package vault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A test that forgets to isolate JASPER_APP_HOME used to silently read and
// rewrite the developer's real ~/.jasper/app.json, evicting genuine recent
// vaults. The refusal has to be louder than the pollution it replaces.
func TestAppHomePath_UnderTest_RefusesTheRealAppHome(t *testing.T) {
	t.Setenv("JASPER_APP_HOME", "")

	got, err := AppHomePath()
	if err == nil {
		t.Fatalf("AppHomePath() = %q, want an error: an unisolated test resolved the real app home", got)
	}
	if !strings.Contains(err.Error(), "JASPER_APP_HOME") {
		t.Errorf("error %q does not name JASPER_APP_HOME, so it does not say how to fix it", err)
	}
}

func TestAppHomePath_UnderTest_HonoursAnIsolatedAppHome(t *testing.T) {
	want := t.TempDir()
	t.Setenv("JASPER_APP_HOME", want)

	got, err := AppHomePath()
	if err != nil {
		t.Fatalf("AppHomePath() error = %v, want the isolated path", err)
	}
	if got != filepath.Clean(want) {
		t.Errorf("AppHomePath() = %q, want %q", got, want)
	}
}

// The guard must not reach into $HOME even to decide it should refuse.
func TestAppHomePath_UnderTest_DoesNotTouchTheRealHome(t *testing.T) {
	t.Setenv("JASPER_APP_HOME", "")

	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home dir to guard: %v", err)
	}
	got, err := AppHomePath()
	if err == nil && strings.HasPrefix(got, home) {
		t.Fatalf("AppHomePath() = %q, which is inside the real home %q", got, home)
	}
}
