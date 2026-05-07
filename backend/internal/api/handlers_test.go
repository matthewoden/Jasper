package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// fakeFileStore — same shape as the one in notes/service_test.go, copied
// here so the api package's tests do not have a test-only dependency on
// the notes package's test helpers.
type fakeFileStore struct {
	readBytes     []byte
	readErr       error
	statTime      time.Time
	statErr       error
	writeCalls    int
	lastWritePath string
	lastWriteData []byte
	writeErr      error
}

func (f *fakeFileStore) Read(_ string) ([]byte, error) {
	return f.readBytes, f.readErr
}

func (f *fakeFileStore) WriteAtomic(relPath string, data []byte) error {
	f.writeCalls++
	f.lastWritePath = relPath
	cp := make([]byte, len(data))
	copy(cp, data)
	f.lastWriteData = cp
	return f.writeErr
}

func (f *fakeFileStore) Stat(_ string) (time.Time, error) {
	return f.statTime, f.statErr
}

// Phase 3 Plan 03-03 — extended notes.FileStore port methods. The
// api-package tests do not exercise these mutation primitives directly
// (those are covered by service_test.go + ops_test.go); default no-ops
// keep the port satisfied at compile time.
func (f *fakeFileStore) CreateFile(_ string) error        { return nil }
func (f *fakeFileStore) DeleteFile(_ string) error        { return nil }
func (f *fakeFileStore) MoveFile(_, _ string) error       { return nil }
func (f *fakeFileStore) CreateDir(_ string) error         { return nil }
func (f *fakeFileStore) DeleteDir(_ string, _ bool) error { return nil }
func (f *fakeFileStore) MoveDir(_, _ string) error        { return nil }

// setupTestServer mounts the StrictServerInterface bridge under
// `r.Route("/api/v1", ...)` so the test URLs match the production
// routes from Plan 04 (Pitfall 13).
func setupTestServer(t *testing.T, files notes.FileStore) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := notes.NewService(files, nil, nil, logger)
	srv := NewServer(svc, logger)
	si := NewStrictHandler(srv, nil)

	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r)
}

func mustGet(t *testing.T, ts *httptest.Server, path string) (*http.Response, []byte) {
	t.Helper()
	resp, err := http.Get(ts.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp, body
}

func mustPut(t *testing.T, ts *httptest.Server, path string, body []byte) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, ts.URL+path, bytes.NewReader(body))
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

// Test H1: GET on the seeded scratchpad UUID returns 200 + the expected
// Note shape.
func TestGetNoteById_OK(t *testing.T) {
	files := &fakeFileStore{
		readBytes: []byte("hello"),
		statTime:  time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	}
	ts := setupTestServer(t, files)
	defer ts.Close()

	resp, body := mustGet(t, ts, "/api/v1/notes/"+notes.ScratchpadUUID.String())
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var got Note
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if uuid.UUID(got.Id) != notes.ScratchpadUUID {
		t.Errorf("Id: got %v, want %v", got.Id, notes.ScratchpadUUID)
	}
	if got.Path != notes.ScratchpadRelPath {
		t.Errorf("Path: got %q, want %q", got.Path, notes.ScratchpadRelPath)
	}
	if got.Content != "hello" {
		t.Errorf("Content: got %q, want %q", got.Content, "hello")
	}
	if got.UpdatedAt.IsZero() {
		t.Errorf("UpdatedAt: got zero time")
	}
}

// Test H2: GET on a random UUID returns 404 with Error{code: "not_found"}.
func TestGetNoteById_NotFound(t *testing.T) {
	files := &fakeFileStore{}
	ts := setupTestServer(t, files)
	defer ts.Close()

	random := uuid.New()
	resp, body := mustGet(t, ts, "/api/v1/notes/"+random.String())
	if resp.StatusCode != 404 {
		t.Fatalf("status: got %d, want 404; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "not_found" {
		t.Errorf("Code: got %q, want %q", got.Code, "not_found")
	}
	if got.Message == "" {
		t.Errorf("Message: empty")
	}
}

// Test H3: GET with a non-UUID path parameter returns 400 (the
// oapi-codegen path-param validator rejects it before reaching the
// handler). The exact body shape is the InvalidParamFormatError from
// the generated wrapper, NOT our api.Error — that's expected.
func TestGetNoteById_BadUUID(t *testing.T) {
	files := &fakeFileStore{}
	ts := setupTestServer(t, files)
	defer ts.Close()

	resp, body := mustGet(t, ts, "/api/v1/notes/not-a-uuid")
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
}

// Test H4: PUT with a valid body updates the file, returns 200, and
// records the WriteAtomic call.
func TestPutNoteById_OK(t *testing.T) {
	files := &fakeFileStore{statTime: time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)}
	ts := setupTestServer(t, files)
	defer ts.Close()

	resp, respBody := mustPut(t, ts, "/api/v1/notes/"+notes.ScratchpadUUID.String(),
		[]byte(`{"content": "# changed"}`))
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, respBody)
	}
	var got UpdateNoteResponse
	if err := json.Unmarshal(respBody, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, respBody)
	}
	if uuid.UUID(got.Id) != notes.ScratchpadUUID {
		t.Errorf("Id: got %v, want %v", got.Id, notes.ScratchpadUUID)
	}
	if got.Path != notes.ScratchpadRelPath {
		t.Errorf("Path: got %q, want %q", got.Path, notes.ScratchpadRelPath)
	}
	if got.UpdatedAt.IsZero() {
		t.Errorf("UpdatedAt: zero")
	}

	if files.writeCalls != 1 {
		t.Errorf("WriteAtomic was called %d times, want 1", files.writeCalls)
	}
	if string(files.lastWriteData) != "# changed" {
		t.Errorf("lastWriteData: got %q, want %q", files.lastWriteData, "# changed")
	}
	if files.lastWritePath != notes.ScratchpadRelPath {
		t.Errorf("lastWritePath: got %q, want %q", files.lastWritePath, notes.ScratchpadRelPath)
	}
}

// Test H5: PUT with a malformed JSON body returns 400. The strict-server
// middleware decodes the body and calls RequestErrorHandlerFunc on a
// JSON parse error.
func TestPutNoteById_BadJSON(t *testing.T) {
	files := &fakeFileStore{}
	ts := setupTestServer(t, files)
	defer ts.Close()

	resp, body := mustPut(t, ts, "/api/v1/notes/"+notes.ScratchpadUUID.String(),
		[]byte(`{not json`))
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
	if files.writeCalls != 0 {
		t.Errorf("WriteAtomic was called for malformed body: %d times", files.writeCalls)
	}
}

// Test H6: PUT against an unknown UUID returns 404 with code "not_found".
func TestPutNoteById_NotFound(t *testing.T) {
	files := &fakeFileStore{}
	ts := setupTestServer(t, files)
	defer ts.Close()

	random := uuid.New()
	resp, body := mustPut(t, ts, "/api/v1/notes/"+random.String(),
		[]byte(`{"content": "ignored"}`))
	if resp.StatusCode != 404 {
		t.Fatalf("status: got %d, want 404; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "not_found" {
		t.Errorf("Code: got %q, want %q", got.Code, "not_found")
	}
	if files.writeCalls != 0 {
		t.Errorf("WriteAtomic was called for unknown UUID: %d times", files.writeCalls)
	}
}

// Test H7: PUT where WriteAtomic fails returns 500 with code
// "write_failed".
func TestPutNoteById_WriteFailure(t *testing.T) {
	files := &fakeFileStore{
		writeErr: errors.New("disk full"),
		statTime: time.Now(),
	}
	ts := setupTestServer(t, files)
	defer ts.Close()

	resp, body := mustPut(t, ts, "/api/v1/notes/"+notes.ScratchpadUUID.String(),
		[]byte(`{"content": "hello"}`))
	if resp.StatusCode != 500 {
		t.Fatalf("status: got %d, want 500; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "write_failed" {
		t.Errorf("Code: got %q, want %q", got.Code, "write_failed")
	}
	// CR-02: the wire-format message MUST be generic — the wrapped
	// error chain (which can include absolute filesystem paths like
	// the temp file in the data root) is logged server-side only.
	if strings.Contains(got.Message, "disk full") {
		t.Errorf("Message leaked underlying error sentinel: %q", got.Message)
	}
	if got.Message == "" {
		t.Errorf("Message empty — expected a generic user-facing string")
	}
}

// Sanity: exercise the OpenAPI-spec-loading helper exposed by the
// generated code. Catches a regression where the embedded spec rotted.
// (The handlers don't depend on this in production but Plan 04 may
// want to expose /api/v1/openapi.json from the same package.)
func TestGenerated_GetSwagger(t *testing.T) {
	if _, err := GetSwagger(); err != nil {
		t.Fatalf("GetSwagger: %v", err)
	}
}
