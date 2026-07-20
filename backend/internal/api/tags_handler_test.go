package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

type tagFakeIndex struct {
	mu sync.RWMutex

	summaries map[uuid.UUID]notes.NoteSummary

	tags map[string]map[uuid.UUID]bool

	listTagsErr   error
	notesByTagErr error
	renameTagErr  error
	deleteTagErr  error
}

func newTagFakeIndex() *tagFakeIndex {
	return &tagFakeIndex{
		summaries: make(map[uuid.UUID]notes.NoteSummary),
		tags:      make(map[string]map[uuid.UUID]bool),
	}
}

func (f *tagFakeIndex) addNote(id uuid.UUID, relPath, title string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.summaries[id] = notes.NoteSummary{ID: id, Path: relPath, Title: title, UpdatedAt: time.Now()}
}

func (f *tagFakeIndex) addTag(tagName string, ids ...uuid.UUID) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.tags[tagName] == nil {
		f.tags[tagName] = make(map[uuid.UUID]bool)
	}
	for _, id := range ids {
		f.tags[tagName][id] = true
	}
}

func (f *tagFakeIndex) Upsert(_ context.Context, _ notes.NoteRecord) error { return nil }
func (f *tagFakeIndex) Delete(_ context.Context, _ uuid.UUID) error        { return nil }
func (f *tagFakeIndex) List(_ context.Context) ([]notes.NoteSummary, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	out := make([]notes.NoteSummary, 0, len(f.summaries))
	for _, s := range f.summaries {
		out = append(out, s)
	}
	return out, nil
}

func (f *tagFakeIndex) LookupByPath(_ context.Context, _ string) (notes.NoteRecord, error) {
	return notes.NoteRecord{}, notes.ErrNotFound
}

func (f *tagFakeIndex) MovePathPrefix(_ context.Context, _, _ string) (int, error) { return 0, nil }

func (f *tagFakeIndex) DeleteByPathPrefix(_ context.Context, _ string) (int, error) { return 0, nil }
func (f *tagFakeIndex) SyncTags(_ context.Context, _ uuid.UUID, _ []string) error   { return nil }
func (f *tagFakeIndex) SyncBacklinks(_ context.Context, _ uuid.UUID, _ string,
	_ []markdown.WikiLinkRef, _ *notes.Registry, _ []byte,
) error {
	return nil
}

func (f *tagFakeIndex) SourcesByBacklinkTitle(_ context.Context, _ string) ([]notes.NoteSummary, error) {
	return []notes.NoteSummary{}, nil
}

func (f *tagFakeIndex) UpdateBacklinksTargetTitle(_ context.Context, _, _ string, _ *uuid.UUID) error {
	return nil
}

func (f *tagFakeIndex) GetBacklinks(_ context.Context, _ uuid.UUID) ([]notes.BacklinkRow, error) {
	return []notes.BacklinkRow{}, nil
}

func (f *tagFakeIndex) SearchTitles(_ context.Context, _ string, _ int) ([]notes.SearchResult, error) {
	return []notes.SearchResult{}, nil
}

func (f *tagFakeIndex) SearchFTS(_ context.Context, _ string, _ []string, _ int, _ string) ([]notes.SearchHit, error) {
	return []notes.SearchHit{}, nil
}

func (f *tagFakeIndex) ListTags(_ context.Context) ([]notes.TagWithCount, error) {
	if f.listTagsErr != nil {
		return nil, f.listTagsErr
	}
	f.mu.RLock()
	defer f.mu.RUnlock()
	out := make([]notes.TagWithCount, 0, len(f.tags))
	for name, carriers := range f.tags {
		out = append(out, notes.TagWithCount{Name: name, Count: len(carriers)})
	}

	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[i].Name > out[j].Name {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out, nil
}

func (f *tagFakeIndex) NotesByTag(_ context.Context, name string) ([]notes.NoteSummary, error) {
	if f.notesByTagErr != nil {
		return nil, f.notesByTagErr
	}
	f.mu.RLock()
	defer f.mu.RUnlock()
	carriers := f.tags[name]
	out := make([]notes.NoteSummary, 0, len(carriers))
	for id := range carriers {
		if s, ok := f.summaries[id]; ok {
			out = append(out, s)
		}
	}
	return out, nil
}

func (f *tagFakeIndex) RenameTag(_ context.Context, oldName, newName string) ([]uuid.UUID, error) {
	if f.renameTagErr != nil {
		return nil, f.renameTagErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	carriers, ok := f.tags[oldName]
	if !ok || len(carriers) == 0 {
		return nil, notes.ErrTagNotFound
	}
	if _, exists := f.tags[newName]; exists {
		return nil, notes.ErrTagCollision
	}
	f.tags[newName] = carriers
	delete(f.tags, oldName)
	ids := make([]uuid.UUID, 0, len(carriers))
	for id := range carriers {
		ids = append(ids, id)
	}
	return ids, nil
}

func (f *tagFakeIndex) DeleteTag(_ context.Context, name string) ([]uuid.UUID, error) {
	if f.deleteTagErr != nil {
		return nil, f.deleteTagErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	carriers, ok := f.tags[name]
	if !ok || len(carriers) == 0 {
		return nil, notes.ErrTagNotFound
	}
	ids := make([]uuid.UUID, 0, len(carriers))
	for id := range carriers {
		ids = append(ids, id)
	}
	delete(f.tags, name)
	return ids, nil
}

func setupTagServer(t *testing.T, idx *tagFakeIndex) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &tagFakeFileStore{}

	svc := notes.NewService(files, idx, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, nil, logger, "")
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r)
}

type tagFakeFileStore struct{}

func (f *tagFakeFileStore) Read(_ string) ([]byte, error)        { return nil, nil }
func (f *tagFakeFileStore) WriteAtomic(_ string, _ []byte) error { return nil }
func (f *tagFakeFileStore) Stat(_ string) (time.Time, error)     { return time.Now(), nil }
func (f *tagFakeFileStore) CreateFile(_ string) error            { return nil }
func (f *tagFakeFileStore) DeleteFile(_ string) error            { return nil }
func (f *tagFakeFileStore) MoveFile(_, _ string) error           { return nil }
func (f *tagFakeFileStore) CreateDir(_ string) error             { return nil }
func (f *tagFakeFileStore) DeleteDir(_ string, _ bool) error     { return nil }
func (f *tagFakeFileStore) MoveDir(_, _ string) error            { return nil }
func (f *tagFakeFileStore) TrashFile(_ string) (string, error)   { return "", nil }
func (f *tagFakeFileStore) TrashDir(_ string) (string, error)    { return "", nil }

// GT1: empty vault returns 200 with `{tags: []}`.
func TestGetTags_GT1_Empty(t *testing.T) {
	t.Parallel()
	idx := newTagFakeIndex()
	ts := setupTagServer(t, idx)
	defer ts.Close()

	resp, body := mustGet(t, ts, "/api/v1/tags")
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	tagsField, ok := got["tags"]
	if !ok {
		t.Fatalf("tags key missing; body=%s", body)
	}
	arr, ok := tagsField.([]any)
	if !ok {
		t.Fatalf("tags: got %T, want []any; body=%s", tagsField, body)
	}
	if len(arr) != 0 {
		t.Errorf("tags len: got %d, want 0", len(arr))
	}
}

// GT2: vault with 3 tags returns 200 with alphabetical entries.
func TestGetTags_GT2_Alphabetical(t *testing.T) {
	t.Parallel()
	idx := newTagFakeIndex()
	idA := uuid.New()
	idB := uuid.New()
	idC := uuid.New()
	idx.addNote(idA, "a.md", "A")
	idx.addNote(idB, "b.md", "B")
	idx.addNote(idC, "c.md", "C")
	idx.addTag("zebra", idA)
	idx.addTag("alpha", idA, idB)
	idx.addTag("mango", idC)
	ts := setupTagServer(t, idx)
	defer ts.Close()

	resp, body := mustGet(t, ts, "/api/v1/tags")
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var got TagList
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if len(got.Tags) != 3 {
		t.Fatalf("tags len: got %d, want 3", len(got.Tags))
	}

	if got.Tags[0].Name != "alpha" || got.Tags[1].Name != "mango" || got.Tags[2].Name != "zebra" {
		t.Errorf("tags order: got %v, want [alpha mango zebra]", tagNames(got.Tags))
	}

	if got.Tags[0].Count != 2 {
		t.Errorf("alpha count: got %d, want 2", got.Tags[0].Count)
	}
}

func tagNames(tags []TagWithCount) []string {
	names := make([]string, len(tags))
	for i, t := range tags {
		names[i] = t.Name
	}
	return names
}

// GN1: existing tag with 2 carriers returns 200.
func TestGetTagNotes_GN1_Carriers(t *testing.T) {
	t.Parallel()
	idx := newTagFakeIndex()
	idA := uuid.New()
	idB := uuid.New()
	idx.addNote(idA, "a.md", "A")
	idx.addNote(idB, "b.md", "B")
	idx.addTag("foo", idA, idB)
	ts := setupTagServer(t, idx)
	defer ts.Close()

	resp, body := mustGet(t, ts, "/api/v1/tags/foo/notes")
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var got NoteList
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if len(got.Notes) != 2 {
		t.Errorf("notes len: got %d, want 2", len(got.Notes))
	}
}

// GN2: nonexistent tag returns 404.
func TestGetTagNotes_GN2_NotFound(t *testing.T) {
	t.Parallel()
	idx := newTagFakeIndex()
	ts := setupTagServer(t, idx)
	defer ts.Close()

	resp, body := mustGet(t, ts, "/api/v1/tags/nonexistent/notes")
	if resp.StatusCode != 404 {
		t.Fatalf("status: got %d, want 404; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "not_found" {
		t.Errorf("code: got %q, want not_found", got.Code)
	}
}

// PT1: rename foo to feature returns 200.
func TestPutTag_PT1_Rename(t *testing.T) {
	t.Parallel()
	idx := newTagFakeIndex()
	idA := uuid.New()
	idB := uuid.New()
	idx.addNote(idA, "a.md", "A")
	idx.addNote(idB, "b.md", "B")
	idx.addTag("foo", idA, idB)
	ts := setupTagServer(t, idx)
	defer ts.Close()

	payload, _ := json.Marshal(map[string]string{"new_name": "feature"})
	resp, body := mustPut(t, ts, "/api/v1/tags/foo", payload)
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var got TagRenameResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.OldName != "foo" {
		t.Errorf("old_name: got %q, want foo", got.OldName)
	}
	if got.NewName != "feature" {
		t.Errorf("new_name: got %q, want feature", got.NewName)
	}
	if len(got.TouchedNoteIds) != 2 {
		t.Errorf("touched_note_ids: got %d, want 2", len(got.TouchedNoteIds))
	}
}

// PT2: invalid new_name charset returns 400.
func TestPutTag_PT2_InvalidNewName(t *testing.T) {
	t.Parallel()
	idx := newTagFakeIndex()
	ts := setupTagServer(t, idx)
	defer ts.Close()

	payload, _ := json.Marshal(map[string]string{"new_name": "INVALID_UPPERCASE"})
	resp, body := mustPut(t, ts, "/api/v1/tags/foo", payload)
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
}

// PT3: source tag not found returns 404.
func TestPutTag_PT3_SourceNotFound(t *testing.T) {
	t.Parallel()
	idx := newTagFakeIndex()
	ts := setupTagServer(t, idx)
	defer ts.Close()

	payload, _ := json.Marshal(map[string]string{"new_name": "newname"})
	resp, body := mustPut(t, ts, "/api/v1/tags/nonexistent", payload)
	if resp.StatusCode != 404 {
		t.Fatalf("status: got %d, want 404; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "not_found" {
		t.Errorf("code: got %q, want not_found", got.Code)
	}
}

// PT4: new_name collides with existing tag returns 409.
func TestPutTag_PT4_Collision(t *testing.T) {
	t.Parallel()
	idx := newTagFakeIndex()
	idA := uuid.New()
	idx.addNote(idA, "a.md", "A")
	idx.addTag("foo", idA)
	idx.addTag("feature", idA)
	ts := setupTagServer(t, idx)
	defer ts.Close()

	payload, _ := json.Marshal(map[string]string{"new_name": "feature"})
	resp, body := mustPut(t, ts, "/api/v1/tags/foo", payload)
	if resp.StatusCode != 409 {
		t.Fatalf("status: got %d, want 409; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "conflict" {
		t.Errorf("code: got %q, want conflict", got.Code)
	}
}

// DT1: delete foo with 3 carriers returns 200.
func TestDeleteTag_DT1_Delete(t *testing.T) {
	t.Parallel()
	idx := newTagFakeIndex()
	idA := uuid.New()
	idB := uuid.New()
	idC := uuid.New()
	idx.addNote(idA, "a.md", "A")
	idx.addNote(idB, "b.md", "B")
	idx.addNote(idC, "c.md", "C")
	idx.addTag("foo", idA, idB, idC)
	ts := setupTagServer(t, idx)
	defer ts.Close()

	resp, body := mustDelete(t, ts, "/api/v1/tags/foo")
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var got TagDeleteResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.OldName != "foo" {
		t.Errorf("old_name: got %q, want foo", got.OldName)
	}
	if len(got.TouchedNoteIds) != 3 {
		t.Errorf("touched_note_ids: got %d, want 3", len(got.TouchedNoteIds))
	}
}

// DT2: nonexistent tag returns 404.
func TestDeleteTag_DT2_NotFound(t *testing.T) {
	t.Parallel()
	idx := newTagFakeIndex()
	ts := setupTagServer(t, idx)
	defer ts.Close()

	resp, body := mustDelete(t, ts, "/api/v1/tags/nonexistent")
	if resp.StatusCode != 404 {
		t.Fatalf("status: got %d, want 404; body=%s", resp.StatusCode, body)
	}
	var got Error
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if got.Code != "not_found" {
		t.Errorf("code: got %q, want not_found", got.Code)
	}
}

// PT5: PutTag returns 400 for empty body.
func TestPutTag_PT5_NilBody(t *testing.T) {
	t.Parallel()
	idx := newTagFakeIndex()
	ts := setupTagServer(t, idx)
	defer ts.Close()

	resp, body := mustPut(t, ts, "/api/v1/tags/foo", []byte(`{not json`))
	if resp.StatusCode != 400 {
		t.Fatalf("status: got %d, want 400; body=%s", resp.StatusCode, body)
	}
}

// Verify that PutTag handler validates the old name too (PT2 extension).
func TestPutTag_PT2b_InvalidOldName(t *testing.T) {
	t.Parallel()
	idx := newTagFakeIndex()
	ts := setupTagServer(t, idx)
	defer ts.Close()

	payload, _ := json.Marshal(map[string]string{"new_name": "valid"})
	resp, body := mustPut(t, ts, "/api/v1/tags/INVALID-NAME", payload)

	if resp.StatusCode != 400 && resp.StatusCode != 404 {
		t.Fatalf("status: got %d, want 400 or 404; body=%s", resp.StatusCode, body)
	}
}

// Verify NotesByTag returns non-empty tags field even when tags are present.
func TestGetTagNotes_NilVsEmpty(t *testing.T) {
	t.Parallel()
	idx := newTagFakeIndex()
	idA := uuid.New()
	idx.addNote(idA, "a.md", "A")
	idx.addTag("solo", idA)
	ts := setupTagServer(t, idx)
	defer ts.Close()

	resp, body := mustGet(t, ts, "/api/v1/tags/solo/notes")
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}

	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	notesField, ok := raw["notes"]
	if !ok {
		t.Fatalf("notes key missing; body=%s", body)
	}
	if !strings.Contains(string(body), "[") {
		t.Errorf("notes field should be array; body=%s", body)
	}
	arr, ok := notesField.([]any)
	if !ok {
		t.Fatalf("notes: got %T, want []any; body=%s", notesField, body)
	}
	if len(arr) != 1 {
		t.Errorf("notes len: got %d, want 1", len(arr))
	}
}
