package app

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

// startupErrorReadyProbe succeeds only on the startup-error page. Every
// boot-error handler answers 503, so the code in the body is what separates
// them (see diskFullReadyProbe).
func startupErrorReadyProbe(addr string) func() error {
	client := &http.Client{Timeout: 100 * time.Millisecond}
	return func() error {
		resp, err := client.Get("http://" + addr + "/api/v1/admin/status")
		if err != nil {
			return err
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusServiceUnavailable {
			return errors.New("admin/status: got " + resp.Status + ", want 503; body=" + string(body))
		}
		if !strings.Contains(string(body), `"code":"startup_failed"`) {
			return errors.New("admin/status: 503 but not the startup-error page; body=" + string(body))
		}
		return nil
	}
}

// TestRun_RegistryHydrateFailure_RefusesToServeEmptyVault — when the index
// cannot be listed, boot must NOT come up serving a vault that looks empty.
// The registry is the UUID -> path map, so an empty one breaks persisted tabs,
// bookmarks, deep links and every wiki-link, while the notes sit untouched on
// disk. Warn-and-proceed turned a loud recoverable failure into silent apparent
// data loss (JASPER-9).
func TestRun_RegistryHydrateFailure_RefusesToServeEmptyVault(t *testing.T) {
	t.Setenv("JASPER_APP_HOME", filepath.Join(t.TempDir(), ".jasper"))
	dir := t.TempDir()
	seedRealSQLiteDB(t, dir)

	// Drop the table the registry hydrates from. The migration ledger still
	// records every migration as applied, so boot will not recreate it — this
	// is the permanent-failure class, which no amount of retrying clears.
	dbPath := vault.AppDBPath(dir)
	pair, err := sqlite.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("open seeded db: %v", err)
	}
	if _, err := pair.Writer.ExecContext(context.Background(), `DROP TABLE notes`); err != nil {
		t.Fatalf("drop notes: %v", err)
	}
	if err := pair.Close(); err != nil {
		t.Fatalf("close seeded db: %v", err)
	}

	ln, addr := pickFreeListener(t)
	a, err := New(Config{
		DataDir:             dir,
		ListenAddr:          addr,
		ListenerOverride:    ln,
		Logger:              slog.New(slog.NewTextHandler(io.Discard, nil)),
		DisableFirstRunGate: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	if err := waitForBoot(t, 5*time.Second, runErr, startupErrorReadyProbe(addr)); err != nil {
		cancel()
		<-runErr
		t.Fatalf("expected the startup-error page after a failed registry hydrate: %v", err)
	}
	cancel()
	<-runErr
}

type stubLister struct {
	calls     int
	failures  int
	summaries []notes.NoteSummary
	err       error
}

func (s *stubLister) List(context.Context) ([]notes.NoteSummary, error) {
	s.calls++
	if s.calls <= s.failures {
		return nil, s.err
	}
	return s.summaries, nil
}

// A momentary lock under parallel load is the failure actually observed, and it
// clears on its own — so a bounded retry should ride it out rather than refuse
// to boot.
func TestHydrateList_RetriesThenSucceeds(t *testing.T) {
	t.Parallel()
	want := []notes.NoteSummary{{ID: uuid.New(), Path: "a.md", Title: "a"}}
	s := &stubLister{failures: 2, summaries: want, err: errors.New("database is locked")}

	got, err := hydrateList(context.Background(), s, slog.New(slog.NewTextHandler(io.Discard, nil)), 3, 0)
	if err != nil {
		t.Fatalf("hydrateList: %v", err)
	}
	if len(got) != 1 || got[0].Path != "a.md" {
		t.Fatalf("summaries: got %v, want a.md", got)
	}
	if s.calls != 3 {
		t.Errorf("calls: got %d, want 3", s.calls)
	}
}

func TestHydrateList_FailsAfterExhaustingAttempts(t *testing.T) {
	t.Parallel()
	sentinel := errors.New("no such table: notes")
	s := &stubLister{failures: 99, err: sentinel}

	_, err := hydrateList(context.Background(), s, slog.New(slog.NewTextHandler(io.Discard, nil)), 3, 0)
	if err == nil {
		t.Fatal("hydrateList: got nil error, want failure after exhausting attempts")
	}
	if !errors.Is(err, sentinel) {
		t.Errorf("error must wrap the cause: got %v", err)
	}
	if s.calls != 3 {
		t.Errorf("calls: got %d, want 3", s.calls)
	}
}
