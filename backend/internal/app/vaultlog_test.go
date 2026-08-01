package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

// syncBuffer is a bytes.Buffer safe for the concurrent writes a booted
// app makes from its listener and background goroutines.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// errNotYet keeps a waitFor probe polling until the log record appears.
var errNotYet = errors.New("record not in the log file yet")

// readVaultLog returns the contents of <vaultDir>/.jasper/logs/jasper.log,
// or "" when the file does not exist.
func readVaultLog(t *testing.T, vaultDir string) string {
	t.Helper()
	body, err := os.ReadFile(vault.LogsPath(vaultDir))
	if err != nil {
		if os.IsNotExist(err) {
			return ""
		}
		t.Fatalf("read %s: %v", vault.LogsPath(vaultDir), err)
	}
	return string(body)
}

// TestBoot_WritesPerVaultLogFile — every "check the log" pointer in
// the product (migration status, the startup error pages, doctor) targets
// <vault>/.jasper/logs/jasper.log. Booting a vault must actually create it
// and write JSON records to it, with the injected console handler still
// receiving the same records.
func TestBoot_WritesPerVaultLogFile(t *testing.T) {
	t.Setenv("JASPER_APP_HOME", filepath.Join(t.TempDir(), ".jasper"))
	dir := t.TempDir()
	ln, addr := pickFreeListener(t)

	console := &syncBuffer{}
	a, err := New(Config{
		DataDir:             dir,
		ListenAddr:          addr,
		ListenerOverride:    ln,
		Logger:              slog.New(slog.NewTextHandler(console, nil)),
		DisableFirstRunGate: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	if err := waitFor(t, 5*time.Second, httpReadyProbe(addr)); err != nil {
		cancel()
		<-runErr
		t.Fatalf("listener did not come up: %v", err)
	}

	body := readVaultLog(t, dir)
	if body == "" {
		cancel()
		<-runErr
		t.Fatalf("regression: no log file at %s after boot", vault.LogsPath(dir))
	}

	firstLine := strings.SplitN(strings.TrimSpace(body), "\n", 2)[0]
	var rec map[string]any
	if err := json.Unmarshal([]byte(firstLine), &rec); err != nil {
		t.Errorf("log line is not JSON: %v (line=%q)", err, firstLine)
	}
	if _, ok := rec["msg"]; !ok {
		t.Errorf("log line missing msg field: %q", firstLine)
	}

	if console.String() == "" {
		t.Errorf("console handler starved: the file handler must be added to it, not replace it")
	}

	cancel()
	<-runErr
}

// TestBoot_ReindexRecordReachesTheLogFile — the file the error pages tail
// must carry the boot narrative, not just whichever record happened to be
// first. Asserts a known startup record lands on disk.
func TestBoot_ReindexRecordReachesTheLogFile(t *testing.T) {
	t.Setenv("JASPER_APP_HOME", filepath.Join(t.TempDir(), ".jasper"))
	dir := t.TempDir()
	ln, addr := pickFreeListener(t)

	a, err := New(Config{
		DataDir:             dir,
		ListenAddr:          addr,
		ListenerOverride:    ln,
		Logger:              discardLogger(),
		DisableFirstRunGate: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	err = waitFor(t, 5*time.Second, func() error {
		if strings.Contains(readVaultLog(t, dir), "startup incremental reindex done") {
			return nil
		}
		return errNotYet
	})
	cancel()
	<-runErr
	if err != nil {
		t.Fatalf("startup reindex record never reached %s: %v\nlog=%s",
			vault.LogsPath(dir), err, readVaultLog(t, dir))
	}
}

// TestBootFailure_ErrorPageShowsRealLogLines — the whole point. The
// startup error page tails the vault log, so on the boot failure where the
// user most needs it, the excerpt has to be real records rather than the
// "(no log file yet)" placeholder a never-written file produced.
//
// Failure is forced by parking a directory where app.db belongs, which
// fails sqlite.Open after the logger has already recorded the earlier
// boot steps.
func TestBootFailure_ErrorPageShowsRealLogLines(t *testing.T) {
	t.Setenv("JASPER_APP_HOME", filepath.Join(t.TempDir(), ".jasper"))
	dir := t.TempDir()
	if err := os.MkdirAll(vault.AppDBPath(dir), 0o700); err != nil {
		t.Fatalf("park a directory at app.db: %v", err)
	}

	ln, addr := pickFreeListener(t)
	a, err := New(Config{
		DataDir:             dir,
		ListenAddr:          addr,
		ListenerOverride:    ln,
		Logger:              discardLogger(),
		DisableFirstRunGate: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	var page string
	err = waitFor(t, 5*time.Second, func() error {
		resp, getErr := http.Get("http://" + addr + "/")
		if getErr != nil {
			return getErr
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusInternalServerError {
			return fmt.Errorf("status %d; want 500 (startup-error page)", resp.StatusCode)
		}
		page = string(body)
		return nil
	})
	cancel()
	<-runErr
	if err != nil {
		t.Fatalf("startup-error page never served: %v", err)
	}

	if strings.Contains(page, "(no log file yet)") {
		t.Errorf("regression: error page points at a log file that was never written\npage=%s", page)
	}
	if !strings.Contains(page, "scratchpad") {
		t.Errorf("error page log excerpt has no real boot records\npage=%s", page)
	}
}

// TestVaultLogHandler_DerivedLoggersFollowTheOpenVault — subsystems are
// wired with cfg.Logger (often decorated via .With) while a vault is open
// and are not re-handed a logger afterwards, so a logger captured before
// an attach must route to the vault opened later, attrs intact.
func TestVaultLogHandler_DerivedLoggersFollowTheOpenVault(t *testing.T) {
	dir := t.TempDir()
	a, err := New(Config{
		DataDir:    dir,
		ListenAddr: "127.0.0.1:0",
		Logger:     discardLogger(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	captured := a.cfg.Logger.With("subsystem", "indexer").WithGroup("detail")

	if err := a.attachVaultFileLog(dir); err != nil {
		t.Fatalf("attachVaultFileLog: %v", err)
	}
	captured.Info("reconcile done", "notes", 7)
	if err := a.detachVaultFileLog(); err != nil {
		t.Fatalf("detachVaultFileLog: %v", err)
	}

	body := readVaultLog(t, dir)
	for _, want := range []string{`"subsystem":"indexer"`, `"detail":{"notes":7}`} {
		if !strings.Contains(body, want) {
			t.Errorf("vault log missing %s: %q", want, body)
		}
	}
}

// TestSwitchVault_MovesTheFileLogToTheNewVault — the log follows the open
// vault. After a swap, records land in vault B's log and vault A's log is
// closed, not still being appended to behind the user's back.
func TestSwitchVault_MovesTheFileLogToTheNewVault(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	vaultA := setupSwapVault(t)
	vaultB := setupSwapVault(t)

	appJSONPath := filepath.Join(appHome, "app.json")
	if err := vault.SaveAppJSON(appJSONPath, &vault.AppState{
		CurrentVault: vaultA,
		RecentVaults: []vault.RecentVaultEntry{
			{Path: vaultA, DisplayName: "VaultA", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
			{Path: vaultB, DisplayName: "VaultB", LastOpenedAt: time.Now().UTC(), CreatedAt: time.Now().UTC()},
		},
	}); err != nil {
		t.Fatalf("save app.json: %v", err)
	}
	writeVaultMCPConfig(t, vaultA, 0)
	writeVaultMCPConfig(t, vaultB, 0)

	a := newSwapApp(t, vaultA)
	if err := a.attachVaultFileLog(vaultA); err != nil {
		t.Fatalf("attachVaultFileLog(vaultA): %v", err)
	}
	a.cfg.Logger.Info("before-switch")

	if _, err := a.SwitchVault(context.Background(), vaultB); err != nil {
		t.Fatalf("SwitchVault to vaultB: %v", err)
	}
	a.cfg.Logger.Info("after-switch")

	logA, logB := readVaultLog(t, vaultA), readVaultLog(t, vaultB)

	if !strings.Contains(logA, "before-switch") {
		t.Errorf("vault A log missing its own pre-switch record: %q", logA)
	}
	if strings.Contains(logA, "after-switch") {
		t.Errorf("vault A log still receiving records after the switch: %q", logA)
	}
	if !strings.Contains(logB, "after-switch") {
		t.Errorf("vault B log missing post-switch record: %q", logB)
	}
}

// TestTeardown_DropsBackToConsoleOnly — tearing down a vault must close the
// file sink AND re-point cfg.Logger, or the next records go to a closed
// file and vanish.
func TestTeardown_DropsBackToConsoleOnly(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureDataDir(dir); err != nil {
		t.Fatalf("EnsureDataDir: %v", err)
	}

	console := &syncBuffer{}
	a, err := New(Config{
		DataDir:    dir,
		ListenAddr: "127.0.0.1:0",
		Logger:     slog.New(slog.NewTextHandler(console, nil)),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := a.attachVaultFileLog(dir); err != nil {
		t.Fatalf("attachVaultFileLog: %v", err)
	}

	if err := a.tearDownPerVaultSubsystems(); err != nil {
		t.Fatalf("tearDownPerVaultSubsystems: %v", err)
	}
	if a.fileLogCloser != nil {
		t.Error("fileLogCloser not cleared by teardown")
	}

	before := readVaultLog(t, dir)
	a.cfg.Logger.Info("post-teardown")

	if got := readVaultLog(t, dir); got != before {
		t.Errorf("post-teardown record still written to the torn-down vault log: %q", got)
	}
	if !strings.Contains(console.String(), "post-teardown") {
		t.Errorf("console lost records after teardown: %q", console.String())
	}
}
