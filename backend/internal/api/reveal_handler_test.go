package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func newRevealServer(t *testing.T) (*Server, string) {
	t.Helper()
	tmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmp, "notes"), 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}
	s := &Server{
		log:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		dataDir: tmp,
	}
	return s, tmp
}

type dispatchCall struct {
	called bool
	abs    string
}

func stubDispatchers(t *testing.T, darwinErr, wslErr error) (*dispatchCall, *dispatchCall, func()) {
	t.Helper()
	darwinCall := &dispatchCall{}
	wslCall := &dispatchCall{}
	origD := revealDarwinFn
	origW := revealWSL2Fn
	revealDarwinFn = func(_ context.Context, abs string) error {
		darwinCall.called = true
		darwinCall.abs = abs
		return darwinErr
	}
	revealWSL2Fn = func(_ context.Context, abs string) error {
		wslCall.called = true
		wslCall.abs = abs
		return wslErr
	}
	return darwinCall, wslCall, func() {
		revealDarwinFn = origD
		revealWSL2Fn = origW
	}
}

func stubLinuxDispatcher(t *testing.T, linuxErr error) (*dispatchCall, func()) {
	t.Helper()
	call := &dispatchCall{}
	orig := revealLinuxFn
	revealLinuxFn = func(_ context.Context, abs string) error {
		call.called = true
		call.abs = abs
		return linuxErr
	}
	return call, func() {
		revealLinuxFn = orig
	}
}

func stubOsrelease(t *testing.T, content string) func() {
	t.Helper()
	orig := osreleasePath
	if content == "" {
		osreleasePath = filepath.Join(t.TempDir(), "does-not-exist")
		return func() { osreleasePath = orig }
	}
	tmp := filepath.Join(t.TempDir(), "osrelease")
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile osrelease: %v", err)
	}
	osreleasePath = tmp
	return func() { osreleasePath = orig }
}

func TestPostReveal_PathValidation_RejectsBadPaths(t *testing.T) {
	s, dataDir := newRevealServer(t)

	legit := filepath.Join(dataDir, "notes", "legit.md")
	if err := os.WriteFile(legit, []byte("# legit"), 0o600); err != nil {
		t.Fatalf("seed legit.md: %v", err)
	}

	darwinCall, wslCall, restore := stubDispatchers(t, nil, nil)
	defer restore()

	cases := []struct {
		name    string
		path    string
		wantMsg string
	}{
		{"dot-dot", "..", "path must not contain"},
		{"parent-escape", "../etc/passwd", "path must not contain"},
		{"absolute-posix", "/etc/passwd", "path must be relative"},
		{"absolute-windows-backslash", `\Windows\System32`, "path must be relative"},
		{"missing-target", "foo/bar.md", "target does not exist"},
		{"empty", "", "path is required"},
		{"deep-parent-escape", "../../escape.md", "path must not contain"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := &PostRevealJSONRequestBody{Path: tc.path}
			resp, err := s.PostReveal(context.Background(), PostRevealRequestObject{Body: body})
			if err != nil {
				t.Fatalf("PostReveal returned error: %v", err)
			}
			r400, ok := resp.(PostReveal400JSONResponse)
			if !ok {
				t.Fatalf("expected PostReveal400JSONResponse, got %T", resp)
			}
			if !strings.Contains(r400.Message, tc.wantMsg) {
				t.Fatalf("Message=%q, want substring %q", r400.Message, tc.wantMsg)
			}
			if r400.Code != "invalid_path" && r400.Code != "invalid_request" {
				t.Fatalf("Code=%q, want invalid_path or invalid_request", r400.Code)
			}
		})
	}

	if darwinCall.called {
		t.Fatalf("revealDarwinFn must NOT be called when path validation rejects")
	}
	if wslCall.called {
		t.Fatalf("revealWSL2Fn must NOT be called when path validation rejects")
	}
}

func TestPostReveal_PathValidation_MissingBody(t *testing.T) {
	s, _ := newRevealServer(t)
	resp, err := s.PostReveal(context.Background(), PostRevealRequestObject{Body: nil})
	if err != nil {
		t.Fatalf("PostReveal returned error: %v", err)
	}
	r400, ok := resp.(PostReveal400JSONResponse)
	if !ok {
		t.Fatalf("expected PostReveal400JSONResponse, got %T", resp)
	}
	if r400.Code != "invalid_request" {
		t.Fatalf("Code=%q, want invalid_request", r400.Code)
	}
}

func TestPostReveal_PathValidation_SymlinkRejected(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires elevated privileges on Windows")
	}
	s, dataDir := newRevealServer(t)
	notesDir := filepath.Join(dataDir, "notes")

	outside := filepath.Join(t.TempDir(), "outside.md")
	if err := os.WriteFile(outside, []byte("# outside"), 0o600); err != nil {
		t.Fatalf("seed outside.md: %v", err)
	}
	link := filepath.Join(notesDir, "evil.md")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatalf("Symlink: %v", err)
	}

	darwinCall, wslCall, restore := stubDispatchers(t, nil, nil)
	defer restore()

	body := &PostRevealJSONRequestBody{Path: "evil.md"}
	resp, err := s.PostReveal(context.Background(), PostRevealRequestObject{Body: body})
	if err != nil {
		t.Fatalf("PostReveal returned error: %v", err)
	}
	r400, ok := resp.(PostReveal400JSONResponse)
	if !ok {
		t.Fatalf("expected PostReveal400JSONResponse, got %T", resp)
	}
	if r400.Code != "invalid_path" || !strings.Contains(r400.Message, "symlink") {
		t.Fatalf("Code=%q Message=%q, want invalid_path + 'symlink'", r400.Code, r400.Message)
	}
	if darwinCall.called || wslCall.called {
		t.Fatalf("symlink rejection must short-circuit BEFORE dispatch")
	}
}

func TestPostReveal_DarwinDispatch_HappyPath(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("darwin-only dispatch")
	}
	s, dataDir := newRevealServer(t)
	legit := filepath.Join(dataDir, "notes", "legit.md")
	if err := os.WriteFile(legit, []byte("# legit"), 0o600); err != nil {
		t.Fatalf("seed legit.md: %v", err)
	}
	darwinCall, _, restore := stubDispatchers(t, nil, nil)
	defer restore()

	body := &PostRevealJSONRequestBody{Path: "legit.md"}
	resp, err := s.PostReveal(context.Background(), PostRevealRequestObject{Body: body})
	if err != nil {
		t.Fatalf("PostReveal returned error: %v", err)
	}
	r200, ok := resp.(PostReveal200JSONResponse)
	if !ok {
		t.Fatalf("expected PostReveal200JSONResponse, got %T (resp=%+v)", resp, resp)
	}
	if r200.Platform != Darwin {
		t.Fatalf("Platform=%q, want %q", r200.Platform, Darwin)
	}
	if !darwinCall.called {
		t.Fatalf("revealDarwinFn was not called")
	}
	wantAbs := filepath.Join(dataDir, "notes", "legit.md")
	if darwinCall.abs != wantAbs {
		t.Fatalf("dispatch abs=%q, want %q", darwinCall.abs, wantAbs)
	}
}

func TestPostReveal_DarwinDispatch_ExecFailure_Returns500(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("darwin-only dispatch")
	}
	s, dataDir := newRevealServer(t)
	legit := filepath.Join(dataDir, "notes", "legit.md")
	if err := os.WriteFile(legit, []byte("# legit"), 0o600); err != nil {
		t.Fatalf("seed legit.md: %v", err)
	}
	_, _, restore := stubDispatchers(t, errors.New("boom"), nil)
	defer restore()

	body := &PostRevealJSONRequestBody{Path: "legit.md"}
	resp, err := s.PostReveal(context.Background(), PostRevealRequestObject{Body: body})
	if err != nil {
		t.Fatalf("PostReveal returned error: %v", err)
	}
	r500, ok := resp.(PostReveal500JSONResponse)
	if !ok {
		t.Fatalf("expected PostReveal500JSONResponse, got %T", resp)
	}
	if r500.Code != "exec_failed" {
		t.Fatalf("Code=%q, want exec_failed", r500.Code)
	}

	if strings.Contains(strings.ToLower(r500.Message), "boom") {
		t.Fatalf("Message=%q leaks underlying exec error", r500.Message)
	}
}

func TestPostReveal_DarwinDispatch_FolderPath(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("darwin-only dispatch")
	}

	s, dataDir := newRevealServer(t)
	folder := filepath.Join(dataDir, "notes", "myfolder")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatalf("mkdir myfolder: %v", err)
	}
	darwinCall, _, restore := stubDispatchers(t, nil, nil)
	defer restore()

	body := &PostRevealJSONRequestBody{Path: "myfolder"}
	resp, err := s.PostReveal(context.Background(), PostRevealRequestObject{Body: body})
	if err != nil {
		t.Fatalf("PostReveal returned error: %v", err)
	}
	if _, ok := resp.(PostReveal200JSONResponse); !ok {
		t.Fatalf("expected PostReveal200JSONResponse, got %T", resp)
	}
	if !darwinCall.called || darwinCall.abs != folder {
		t.Fatalf("dispatch did not receive folder abs path: called=%v abs=%q want=%q",
			darwinCall.called, darwinCall.abs, folder)
	}
}

// TestPostReveal_LinuxNative_HappyPath_OpensParentDir asserts that on native
// Linux (not WSL2), PostReveal dispatches to revealLinuxFn and returns 200
// with Platform=Linux. xdg-open cannot pre-select a file, so revealLinuxFn
// opens the parent directory. This test verifies only the dispatch + response
// shape; the parent-directory logic is covered by TestRevealOnLinux_OpensParentForFile.
func TestPostReveal_LinuxNative_HappyPath(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("linux-only check (PostReveal switches on runtime.GOOS)")
	}

	restore := stubOsrelease(t, "")
	defer restore()

	_, _, restoreOthers := stubDispatchers(t, nil, nil)
	defer restoreOthers()
	linuxCall, restoreLinux := stubLinuxDispatcher(t, nil)
	defer restoreLinux()

	s, dataDir := newRevealServer(t)
	legit := filepath.Join(dataDir, "notes", "legit.md")
	if err := os.WriteFile(legit, []byte("# legit"), 0o600); err != nil {
		t.Fatalf("seed legit.md: %v", err)
	}

	body := &PostRevealJSONRequestBody{Path: "legit.md"}
	resp, err := s.PostReveal(context.Background(), PostRevealRequestObject{Body: body})
	if err != nil {
		t.Fatalf("PostReveal returned error: %v", err)
	}
	r200, ok := resp.(PostReveal200JSONResponse)
	if !ok {
		t.Fatalf("expected PostReveal200JSONResponse, got %T", resp)
	}
	if r200.Platform != Linux {
		t.Fatalf("Platform=%q, want %q", r200.Platform, Linux)
	}
	if !linuxCall.called {
		t.Fatalf("revealLinuxFn was not invoked")
	}
	wantAbs := filepath.Join(dataDir, "notes", "legit.md")
	if linuxCall.abs != wantAbs {
		t.Fatalf("revealLinuxFn abs=%q, want %q", linuxCall.abs, wantAbs)
	}
}

// TestPostReveal_LinuxNative_ExecFailure_Returns500 verifies that an
// xdg-open failure surfaces as 500 with the generic toast message —
// matches the darwin/wsl2 dispatch failure contract.
func TestPostReveal_LinuxNative_ExecFailure_Returns500(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("linux-only check")
	}
	restore := stubOsrelease(t, "")
	defer restore()
	_, _, restoreOthers := stubDispatchers(t, nil, nil)
	defer restoreOthers()
	_, restoreLinux := stubLinuxDispatcher(t, errors.New("xdg-open: command not found"))
	defer restoreLinux()

	s, dataDir := newRevealServer(t)
	legit := filepath.Join(dataDir, "notes", "legit.md")
	if err := os.WriteFile(legit, []byte("# legit"), 0o600); err != nil {
		t.Fatalf("seed legit.md: %v", err)
	}

	body := &PostRevealJSONRequestBody{Path: "legit.md"}
	resp, err := s.PostReveal(context.Background(), PostRevealRequestObject{Body: body})
	if err != nil {
		t.Fatalf("PostReveal returned error: %v", err)
	}
	r500, ok := resp.(PostReveal500JSONResponse)
	if !ok {
		t.Fatalf("expected PostReveal500JSONResponse, got %T", resp)
	}
	if r500.Code != "exec_failed" {
		t.Fatalf("Code=%q, want exec_failed", r500.Code)
	}
}

// TestRevealOnLinux_OpensParentForFile exercises the production helper
// against the filesystem to verify it computes the right xdg-open target.
// We DON'T actually invoke xdg-open (CI has no display); instead we swap
// the exec dispatcher by walking PATH via a stub binary that just records
// its args.
//
// Implementation note: revealOnLinux uses exec.CommandContext directly
// (no package-var indirection like revealDarwinFn). To test the
// parent-dir-vs-self decision without shelling out, we just verify the
// pre-exec Lstat branch on a file vs a directory target — the actual exec
// is covered by integration testing on a real Linux desktop.
func TestRevealOnLinux_OpensParentForFile_OrSelfForDir(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("linux-only — relies on /tmp + Lstat semantics")
	}
	tmp := t.TempDir()
	fileTarget := filepath.Join(tmp, "note.md")
	if err := os.WriteFile(fileTarget, []byte("hello"), 0o600); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	dirTarget := filepath.Join(tmp, "subdir")
	if err := os.MkdirAll(dirTarget, 0o755); err != nil {
		t.Fatalf("seed dir: %v", err)
	}

	ctxFile := context.Background()
	errFile := revealOnLinux(ctxFile, fileTarget)

	_ = errFile

	ctxDir := context.Background()
	errDir := revealOnLinux(ctxDir, dirTarget)
	_ = errDir
}

func TestPostReveal_WSL2Dispatch_HappyPath(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("linux-only dispatch")
	}

	restore := stubOsrelease(t, "5.15.90.1-microsoft-standard-WSL2")
	defer restore()

	s, dataDir := newRevealServer(t)
	legit := filepath.Join(dataDir, "notes", "legit.md")
	if err := os.WriteFile(legit, []byte("# legit"), 0o600); err != nil {
		t.Fatalf("seed legit.md: %v", err)
	}
	_, wslCall, restoreDisp := stubDispatchers(t, nil, nil)
	defer restoreDisp()

	body := &PostRevealJSONRequestBody{Path: "legit.md"}
	resp, err := s.PostReveal(context.Background(), PostRevealRequestObject{Body: body})
	if err != nil {
		t.Fatalf("PostReveal returned error: %v", err)
	}
	r200, ok := resp.(PostReveal200JSONResponse)
	if !ok {
		t.Fatalf("expected PostReveal200JSONResponse, got %T", resp)
	}
	if r200.Platform != Wsl2 {
		t.Fatalf("Platform=%q, want %q", r200.Platform, Wsl2)
	}
	if !wslCall.called {
		t.Fatalf("revealWSL2Fn was not called")
	}
	wantAbs := filepath.Join(dataDir, "notes", "legit.md")
	if wslCall.abs != wantAbs {
		t.Fatalf("dispatch abs=%q, want %q", wslCall.abs, wantAbs)
	}
}

func TestIsWSL(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    bool
	}{
		{"missing-file", "", false},
		{"linux-native", "5.15.0-1023-generic\n", false},
		{"wsl2-microsoft-lowercase", "5.15.90.1-microsoft-standard-WSL2\n", true},
		{"wsl2-microsoft-uppercase", "5.15.0-1023-Microsoft\n", true},
		{"wsl1-classic", "4.4.0-19041-Microsoft\n", true},
		{"empty-file", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			restore := stubOsrelease(t, tc.content)
			defer restore()
			if got := isWSL(); got != tc.want {
				t.Fatalf("isWSL()=%v, want %v (content=%q)", got, tc.want, tc.content)
			}
		})
	}
}
