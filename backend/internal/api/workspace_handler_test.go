package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
)

// setupWorkspaceTestServer wires a Server backed by a real
// <dataDir>/.jasper/workspace.json — dataDir's .jasper/ directory must
// already exist (fsstore.AtomicWrite's caller-must-mkdir contract),
// mirroring setupBookmarksTestServer.
func setupWorkspaceTestServer(t *testing.T) (*httptest.Server, *apiBroadcaster) {
	t.Helper()
	dataDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataDir, ".jasper"), 0o755); err != nil {
		t.Fatalf("MkdirAll .jasper: %v", err)
	}

	bc := &apiBroadcaster{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServerWithIndex(nil, nil, nil, nil, bc, logger, dataDir)
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r), bc
}

func mustPutJSON(t *testing.T, ts *httptest.Server, path string, body string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, ts.URL+path, bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT %s: %v", path, err)
	}
	respBody, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp, respBody
}

// TestGetVaultWorkspace_MissingFile_ReturnsDefaults_200 — a fresh vault
// with no workspace.json returns 200 with an empty (default) document.
func TestGetVaultWorkspace_MissingFile_ReturnsDefaults_200(t *testing.T) {
	t.Parallel()
	ts, _ := setupWorkspaceTestServer(t)
	defer ts.Close()

	resp, body := http200Get(t, ts, "/api/v1/vault/workspace")
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var got Workspace
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.NotesSort != nil || got.SearchSort != nil {
		t.Errorf("Workspace = %+v, want both fields nil (default)", got)
	}
}

// TestPutVaultWorkspace_RoundTrip_200 — PUT persists notesSort, GET
// reflects it, and a broadcast fires.
func TestPutVaultWorkspace_RoundTrip_200(t *testing.T) {
	t.Parallel()
	ts, bc := setupWorkspaceTestServer(t)
	defer ts.Close()

	resp, body := mustPutJSON(t, ts, "/api/v1/vault/workspace", `{"notesSort":"name-asc"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("PUT status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var got Workspace
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.NotesSort == nil || *got.NotesSort != "name-asc" {
		t.Fatalf("PUT response NotesSort = %v, want name-asc", got.NotesSort)
	}

	resp, body = http200Get(t, ts, "/api/v1/vault/workspace")
	if resp.StatusCode != 200 {
		t.Fatalf("GET status: got %d; body=%s", resp.StatusCode, body)
	}
	var reloaded Workspace
	if err := json.Unmarshal(body, &reloaded); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if reloaded.NotesSort == nil || *reloaded.NotesSort != "name-asc" {
		t.Fatalf("GET after PUT NotesSort = %v, want name-asc", reloaded.NotesSort)
	}

	bc.mu.Lock()
	n := len(bc.events)
	last := bc.events[len(bc.events)-1]
	bc.mu.Unlock()
	if n == 0 {
		t.Fatalf("expected at least one broadcast event")
	}
	if last.eventType != "workspace:changed" {
		t.Errorf("eventType: got %q, want %q", last.eventType, "workspace:changed")
	}
}

// TestPutVaultWorkspace_SearchSortOnly_LeavesNotesSortUntouched guards the
// per-field setter contract: PUTting only searchSort must not clobber a
// previously-set notesSort.
func TestPutVaultWorkspace_SearchSortOnly_LeavesNotesSortUntouched(t *testing.T) {
	t.Parallel()
	ts, _ := setupWorkspaceTestServer(t)
	defer ts.Close()

	if resp, body := mustPutJSON(t, ts, "/api/v1/vault/workspace", `{"notesSort":"modified-desc"}`); resp.StatusCode != 200 {
		t.Fatalf("PUT notesSort: %d; body=%s", resp.StatusCode, body)
	}

	resp, body := mustPutJSON(t, ts, "/api/v1/vault/workspace", `{"searchSort":"created"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("PUT searchSort: %d; body=%s", resp.StatusCode, body)
	}
	var got Workspace
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.SearchSort == nil || *got.SearchSort != "created" {
		t.Fatalf("SearchSort = %v, want created", got.SearchSort)
	}
	if got.NotesSort == nil || *got.NotesSort != "modified-desc" {
		t.Fatalf("NotesSort = %v, want modified-desc left untouched", got.NotesSort)
	}
}

// TestPutVaultWorkspace_InvalidEnum_400_NoDiskWrite — an out-of-enum value
// is rejected with 400 and never reaches disk.
func TestPutVaultWorkspace_InvalidEnum_400_NoDiskWrite(t *testing.T) {
	t.Parallel()
	ts, _ := setupWorkspaceTestServer(t)
	defer ts.Close()

	resp, body := mustPutJSON(t, ts, "/api/v1/vault/workspace", `{"notesSort":"bogus-sort"}`)
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "invalid_request" {
		t.Errorf("Code: got %q, want %q", got.Code, "invalid_request")
	}

	resp, body = http200Get(t, ts, "/api/v1/vault/workspace")
	if resp.StatusCode != 200 {
		t.Fatalf("GET status: got %d; body=%s", resp.StatusCode, body)
	}
	var reloaded Workspace
	if err := json.Unmarshal(body, &reloaded); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if reloaded.NotesSort != nil {
		t.Errorf("NotesSort = %v, want nil (invalid PUT must not persist)", reloaded.NotesSort)
	}
}
