package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// fakeStatus is a test-only StatusProvider that returns a fixed Status.
type fakeStatus struct{ s migrate.Status }

func (f fakeStatus) Status(_ context.Context) migrate.Status { return f.s }

// setupAdminStatusServer mounts the strict-server bridge under
// `/api/v1` so the test URL matches the production routes (Pitfall 13).
// Accepts an explicit StatusProvider so tests can pin specific states.
func setupAdminStatusServer(t *testing.T, status migrate.StatusProvider) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &fakeFileStore{} // re-use the helper from handlers_test.go
	svc := notes.NewService(files, nil, nil, logger)

	srv := NewServerWithIndex(svc, status, nil, nil, nil, logger, "")
	si := NewStrictHandler(srv, nil)

	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r)
}

// TestGetAdminStatus_OK_ReturnsState — happy-path: state=ok with a
// non-zero NotesIndexed, no FailedMigration, no LogsPath. Asserts wire
// format carries `state` and `notes_indexed`.
func TestGetAdminStatus_OK_ReturnsState(t *testing.T) {
	t.Parallel()
	provider := fakeStatus{s: migrate.Status{
		State:        migrate.StateOK,
		NotesIndexed: 42,
	}}
	ts := setupAdminStatusServer(t, provider)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/admin/status")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}

	var got MigrationStatus
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if string(got.State) != "ok" {
		t.Errorf("State: got %q, want %q", got.State, "ok")
	}
	if got.NotesIndexed == nil {
		t.Fatalf("NotesIndexed: got nil pointer")
	}
	if *got.NotesIndexed != 42 {
		t.Errorf("NotesIndexed value: got %d, want 42", *got.NotesIndexed)
	}
	if got.FailedMigration != nil {
		t.Errorf("FailedMigration should be nil for state=ok; got %q", *got.FailedMigration)
	}
}

// TestGetAdminStatus_RolledBack_IncludesFailedMigration — Path 1 state
// surfaces FailedMigration + LogsPath in the wire format.
func TestGetAdminStatus_RolledBack_IncludesFailedMigration(t *testing.T) {
	t.Parallel()
	provider := fakeStatus{s: migrate.Status{
		State:           migrate.StateRolledBack,
		FailedMigration: "003_tags.sql",
		LogsPath:        "/tmp/jasper.log",
	}}
	ts := setupAdminStatusServer(t, provider)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/admin/status")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}

	var got MigrationStatus
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if string(got.State) != "rolled_back" {
		t.Errorf("State: got %q, want %q", got.State, "rolled_back")
	}
	if got.FailedMigration == nil || *got.FailedMigration != "003_tags.sql" {
		t.Errorf("FailedMigration: got %v, want %q", got.FailedMigration, "003_tags.sql")
	}
	if got.LogsPath == nil || *got.LogsPath != "/tmp/jasper.log" {
		t.Errorf("LogsPath: got %v, want %q", got.LogsPath, "/tmp/jasper.log")
	}
	// Voice rule (T-02-03-03): no SQL leaked. The body should not
	// contain "INVALID SQL", "INSERT", "CREATE", etc. We only check
	// the body bytes here — the handler maps from migrate.Status which
	// doesn't carry SQL anyway, so this is belt-and-braces.
	if strings.Contains(string(body), "INVALID SQL") {
		t.Errorf("body leaked SQL fragment: %s", body)
	}
}

// TestGetAdminStatus_NilProvider_FallsBackToOK — building Server via
// the 2-arg NewServer passes through the nilStatusProvider fallback;
// asserts the wire format reports state=ok.
func TestGetAdminStatus_NilProvider_FallsBackToOK(t *testing.T) {
	t.Parallel()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &fakeFileStore{}
	svc := notes.NewService(files, nil, nil, logger)
	srv := NewServer(svc, logger) // 2-arg form — no status provider passed
	si := NewStrictHandler(srv, nil)

	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	ts := httptest.NewServer(r)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/admin/status")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}

	var got MigrationStatus
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if string(got.State) != "ok" {
		t.Errorf("State: got %q, want %q", got.State, "ok")
	}
}

// TestGetAdminStatus_OmitsEmptyOptionalFields — state=ok with no
// FailedMigration / LogsPath / NotesIndexed should produce a JSON
// object that does NOT include those keys (the openapi spec marks them
// optional and the handler omits zero values).
func TestGetAdminStatus_OmitsEmptyOptionalFields(t *testing.T) {
	t.Parallel()
	provider := fakeStatus{s: migrate.Status{State: migrate.StateOK}}
	ts := setupAdminStatusServer(t, provider)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/admin/status")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}

	// Decode into a generic map so we can inspect key presence.
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if _, ok := raw["failed_migration"]; ok {
		t.Errorf("failed_migration key present on state=ok empty status; want omitted (body=%s)", body)
	}
	if _, ok := raw["logs_path"]; ok {
		t.Errorf("logs_path key present on state=ok empty status; want omitted (body=%s)", body)
	}
	if _, ok := raw["notes_indexed"]; ok {
		t.Errorf("notes_indexed key present on state=ok zero count; want omitted (body=%s)", body)
	}
	if got, _ := raw["state"].(string); got != "ok" {
		t.Errorf("state: got %v, want \"ok\"", raw["state"])
	}
}

// TestGetAdminStatus_StateEnumValuesMatchOpenAPI — sanity that
// migrate.State string constants cast cleanly to api.MigrationStatusState
// via the handler. If the openapi enum changes, this catches the drift
// at the api/migrate seam.
func TestGetAdminStatus_StateEnumValuesMatchOpenAPI(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   migrate.State
		want string
	}{
		{migrate.StateOK, "ok"},
		{migrate.StateRolledBack, "rolled_back"},
		{migrate.StateRebuilding, "rebuilding"},
		{migrate.StateUnrecoverable, "unrecoverable"},
	}
	for _, c := range cases {
		mss := MigrationStatusState(c.in)
		if string(mss) != c.want {
			t.Errorf("MigrationStatusState(%q): got %q, want %q", c.in, mss, c.want)
		}
		if !mss.Valid() {
			t.Errorf("MigrationStatusState(%q).Valid()=false", mss)
		}
	}
}
