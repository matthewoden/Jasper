package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/buildinfo"
)

// TestVersionStringDefault asserts the output when no ldflags are injected
// (buildCommit == ""). Pins the default format so a future buildVersion
// change has to be deliberate.
func TestVersionStringDefault(t *testing.T) {
	got := versionString()
	if !strings.HasPrefix(got, "jasper ") {
		t.Fatalf("versionString() = %q; want prefix %q", got, "jasper ")
	}
	if strings.Contains(got, "(commit ") {
		t.Errorf("versionString() = %q; should NOT contain '(commit ...)' when buildCommit is empty", got)
	}
}

// TestVersionStringWithCommit asserts the full "jasper {ver} (commit {sha})"
// format kicks in once ldflags inject a buildCommit value.
func TestVersionStringWithCommit(t *testing.T) {
	origV := buildinfo.Version
	origC := buildinfo.Commit
	t.Cleanup(func() {
		buildinfo.Version = origV
		buildinfo.Commit = origC
	})

	buildinfo.Version = "1.2.3"
	buildinfo.Commit = "abc1234"
	got := versionString()
	want := "jasper 1.2.3 (commit abc1234)"
	if got != want {
		t.Errorf("versionString() = %q; want %q", got, want)
	}
}

// TestVersionStringEmptyCommitFallback exercises the empty-commit branch
// explicitly with a non-default buildVersion to confirm the formatter
// doesn't print a literal "(commit )" / "(commit dev)" sentinel.
func TestVersionStringEmptyCommitFallback(t *testing.T) {
	origV := buildinfo.Version
	origC := buildinfo.Commit
	t.Cleanup(func() {
		buildinfo.Version = origV
		buildinfo.Commit = origC
	})

	buildinfo.Version = "9.9.9"
	buildinfo.Commit = ""
	got := versionString()
	want := "jasper 9.9.9"
	if got != want {
		t.Errorf("versionString() = %q; want %q", got, want)
	}
}

// TestVersionCmdWritesToStdout asserts the cobra RunE path emits the
// version line to the command's stdout buffer (via cmd.SetOut). This
// is the cobra-side smoke test that complements the formatter tests
// above — it proves the wiring (RunE → cmd.OutOrStdout) is intact.
func TestVersionCmdWritesToStdout(t *testing.T) {
	var buf bytes.Buffer
	versionCmd.SetOut(&buf)
	t.Cleanup(func() {
		versionCmd.SetOut(nil)
	})

	if err := versionCmd.RunE(versionCmd, nil); err != nil {
		t.Fatalf("versionCmd.RunE: unexpected err: %v", err)
	}
	out := buf.String()
	if !strings.HasPrefix(out, "jasper ") {
		t.Errorf("versionCmd output = %q; want prefix %q", out, "jasper ")
	}
	if !strings.HasSuffix(out, "\n") {
		t.Errorf("versionCmd output = %q; expected trailing newline", out)
	}
}
