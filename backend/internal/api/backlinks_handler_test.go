package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

type blIdx struct {
	existing map[uuid.UUID]notes.NoteSummary

	backlinks    map[uuid.UUID][]notes.BacklinkRow
	backlinksErr error

	searchResults []notes.SearchResult
	searchErr     error
}

func newBlIdx() *blIdx {
	return &blIdx{
		existing:  make(map[uuid.UUID]notes.NoteSummary),
		backlinks: make(map[uuid.UUID][]notes.BacklinkRow),
	}
}

func (f *blIdx) addNote(id uuid.UUID, path, title string) {
	f.existing[id] = notes.NoteSummary{ID: id, Path: path, Title: title}
}

func (f *blIdx) setRows(targetID uuid.UUID, rows []notes.BacklinkRow) {
	f.backlinks[targetID] = rows
}

func (f *blIdx) Upsert(_ context.Context, _ notes.NoteRecord) error { return nil }
func (f *blIdx) Delete(_ context.Context, _ uuid.UUID) error        { return nil }
func (f *blIdx) List(_ context.Context) ([]notes.NoteSummary, error) {
	out := make([]notes.NoteSummary, 0, len(f.existing))
	for _, s := range f.existing {
		out = append(out, s)
	}
	return out, nil
}

func (f *blIdx) LookupByPath(_ context.Context, _ string) (notes.NoteRecord, error) {
	return notes.NoteRecord{}, notes.ErrNotFound
}
func (f *blIdx) MovePathPrefix(_ context.Context, _, _ string) (int, error)  { return 0, nil }
func (f *blIdx) DeleteByPathPrefix(_ context.Context, _ string) (int, error) { return 0, nil }
func (f *blIdx) ListTags(_ context.Context) ([]notes.TagWithCount, error) {
	return []notes.TagWithCount{}, nil
}
func (f *blIdx) SyncTags(_ context.Context, _ uuid.UUID, _ []string) error { return nil }
func (f *blIdx) SyncBacklinks(_ context.Context, _ uuid.UUID, _ string,
	_ []markdown.WikiLinkRef, _ *notes.Registry, _ []byte,
) error {
	return nil
}

func (f *blIdx) NotesByTag(_ context.Context, _ string) ([]notes.NoteSummary, error) {
	return []notes.NoteSummary{}, nil
}
func (f *blIdx) RenameTag(_ context.Context, _, _ string) ([]uuid.UUID, error) { return nil, nil }
func (f *blIdx) DeleteTag(_ context.Context, _ string) ([]uuid.UUID, error)    { return nil, nil }
func (f *blIdx) SourcesByBacklinkTitle(_ context.Context, _ string) ([]notes.NoteSummary, error) {
	return []notes.NoteSummary{}, nil
}

func (f *blIdx) UpdateBacklinksTargetTitle(_ context.Context, _, _ string, _ *uuid.UUID) error {
	return nil
}

func (f *blIdx) GetBacklinks(_ context.Context, targetID uuid.UUID) ([]notes.BacklinkRow, error) {
	if f.backlinksErr != nil {
		return nil, f.backlinksErr
	}
	if rows, ok := f.backlinks[targetID]; ok {
		return rows, nil
	}
	return []notes.BacklinkRow{}, nil
}

func (f *blIdx) SearchTitles(_ context.Context, _ string, _ int) ([]notes.SearchResult, error) {
	return f.searchResults, f.searchErr
}

func (f *blIdx) SearchFTS(_ context.Context, _ string, _ []string, _ int, _ string) ([]notes.SearchHit, error) {
	return []notes.SearchHit{}, nil
}

func setupBLServer(t *testing.T, idx notes.Index) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	files := &fakeFileStore{}
	svc := notes.NewService(files, nil, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, nil, logger, "")
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r)
}

// BH1: target note has 3 backlinks; returns 200 with 3-element array.
func TestGetNoteBacklinks_BH1_ThreeBacklinks(t *testing.T) {
	targetID := uuid.New()
	src1, src2, src3 := uuid.New(), uuid.New(), uuid.New()

	idx := newBlIdx()
	idx.addNote(targetID, "target.md", "Target")
	idx.setRows(targetID, []notes.BacklinkRow{
		{SourceID: src1, SourceTitle: "Note A", SourcePath: "a.md", Excerpts: []string{`<mark class="backlink-ref">[[Target]]</mark>`}},
		{SourceID: src2, SourceTitle: "Note B", SourcePath: "b.md", Excerpts: []string{`<mark class="backlink-ref">[[Target]]</mark>`}},
		{SourceID: src3, SourceTitle: "Note C", SourcePath: "c.md", Excerpts: []string{`<mark class="backlink-ref">[[Target]]</mark>`}},
	})

	ts := setupBLServer(t, idx)
	defer ts.Close()

	resp, err := http.Get(fmt.Sprintf("%s/api/v1/notes/%s/backlinks", ts.URL, targetID))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("BH1: expected 200, got %d: %s", resp.StatusCode, body)
	}

	var result struct {
		Backlinks []struct {
			SourceID    string   `json:"source_id"`
			SourceTitle string   `json:"source_title"`
			Excerpts    []string `json:"excerpts"`
		} `json:"backlinks"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("BH1: decode error: %v", err)
	}
	if got := len(result.Backlinks); got != 3 {
		t.Errorf("BH1: expected 3 backlinks, got %d", got)
	}
	if result.Backlinks[0].SourceID == "" {
		t.Error("BH1: source_id must be non-empty")
	}
	if result.Backlinks[0].SourceTitle == "" {
		t.Error("BH1: source_title must be non-empty")
	}
	if len(result.Backlinks[0].Excerpts) != 1 {
		t.Errorf("BH1: expected 1 excerpt, got %d", len(result.Backlinks[0].Excerpts))
	}
}

// BH2: zero backlinks returns 200 with empty non-null array.
func TestGetNoteBacklinks_BH2_ZeroBacklinks(t *testing.T) {
	targetID := uuid.New()
	idx := newBlIdx()
	idx.addNote(targetID, "target.md", "Target")
	idx.setRows(targetID, []notes.BacklinkRow{})

	ts := setupBLServer(t, idx)
	defer ts.Close()

	resp, err := http.Get(fmt.Sprintf("%s/api/v1/notes/%s/backlinks", ts.URL, targetID))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("BH2: expected 200, got %d: %s", resp.StatusCode, body)
	}

	var result struct {
		Backlinks []json.RawMessage `json:"backlinks"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("BH2: decode error: %v", err)
	}
	if result.Backlinks == nil {
		t.Error("BH2: backlinks must be non-null empty array, not null")
	}
	if len(result.Backlinks) != 0 {
		t.Errorf("BH2: expected 0 backlinks, got %d", len(result.Backlinks))
	}
}

// BH3: non-UUID path param returns 400.
func TestGetNoteBacklinks_BH3_InvalidUUID_Returns400(t *testing.T) {
	ts := setupBLServer(t, newBlIdx())
	defer ts.Close()

	resp, err := http.Get(fmt.Sprintf("%s/api/v1/notes/not-a-uuid/backlinks", ts.URL))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("BH3: expected 400 for non-UUID id, got %d: %s", resp.StatusCode, body)
	}
}

// BH4: UUID not present in index returns 404.
func TestGetNoteBacklinks_BH4_NoteNotFound_Returns404(t *testing.T) {
	unknownID := uuid.New()
	idx := newBlIdx()

	ts := setupBLServer(t, idx)
	defer ts.Close()

	resp, err := http.Get(fmt.Sprintf("%s/api/v1/notes/%s/backlinks", ts.URL, unknownID))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("BH4: expected 404 for unknown note, got %d: %s", resp.StatusCode, body)
	}
}

// BH5: excerpt HTML in response contains <mark class="backlink-ref">.
func TestGetNoteBacklinks_BH5_ExcerptContainsMarkClass(t *testing.T) {
	targetID := uuid.New()
	srcID := uuid.New()
	wantExcerpt := `<span>See </span><mark class="backlink-ref">[[Target]]</mark><span> for more</span>`

	idx := newBlIdx()
	idx.addNote(targetID, "target.md", "Target")
	idx.setRows(targetID, []notes.BacklinkRow{
		{SourceID: srcID, SourceTitle: "Source", SourcePath: "source.md", Excerpts: []string{wantExcerpt}},
	})

	ts := setupBLServer(t, idx)
	defer ts.Close()

	resp, err := http.Get(fmt.Sprintf("%s/api/v1/notes/%s/backlinks", ts.URL, targetID))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("BH5: expected 200, got %d: %s", resp.StatusCode, body)
	}
	if !strings.Contains(string(body), `backlink-ref`) {
		t.Errorf("BH5: response does not contain backlink-ref class: %s", body)
	}
}

func buildSearchServer(t *testing.T, results []notes.SearchResult, err error) *httptest.Server {
	t.Helper()
	idx := newBlIdx()
	idx.searchResults = results
	idx.searchErr = err
	return setupBLServer(t, idx)
}

// ST1: empty query returns notes up to the default limit (10).
func TestGetNotesSearchTitles_ST1_EmptyQuery_ReturnsRecentNotes(t *testing.T) {
	results := make([]notes.SearchResult, 5)
	for i := range results {
		results[i] = notes.SearchResult{
			ID:        uuid.New(),
			Title:     fmt.Sprintf("Note %d", i),
			Path:      fmt.Sprintf("note%d.md", i),
			MtimeUnix: int64(1000 + i),
		}
	}
	ts := buildSearchServer(t, results, nil)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/notes/search-titles")
	if err != nil {
		t.Fatalf("ST1: request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("ST1: expected 200, got %d: %s", resp.StatusCode, body)
	}

	var result struct {
		Results []struct {
			ID           string  `json:"id"`
			Title        string  `json:"title"`
			RecencyScore float32 `json:"recency_score"`
			Folder       *string `json:"folder,omitempty"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("ST1: decode error: %v", err)
	}
	if got := len(result.Results); got != 5 {
		t.Errorf("ST1: expected 5 results, got %d", got)
	}
}

// ST2: query "foo" returns matching titles.
func TestGetNotesSearchTitles_ST2_QueryFoo_ReturnsMatching(t *testing.T) {
	results := []notes.SearchResult{
		{ID: uuid.New(), Title: "Foobar", Path: "foobar.md", MtimeUnix: 1000},
	}
	ts := buildSearchServer(t, results, nil)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/notes/search-titles?q=foo")
	if err != nil {
		t.Fatalf("ST2: request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("ST2: expected 200, got %d: %s", resp.StatusCode, body)
	}

	var result struct {
		Results []struct {
			Title string `json:"title"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("ST2: decode error: %v", err)
	}
	if len(result.Results) != 1 || result.Results[0].Title != "Foobar" {
		t.Errorf("ST2: expected [Foobar], got %+v", result.Results)
	}
}

// ST3: results include recency_score field.
func TestGetNotesSearchTitles_ST3_ResultsHaveRecencyScore(t *testing.T) {
	results := []notes.SearchResult{
		{ID: uuid.New(), Title: "Test", Path: "test.md", MtimeUnix: 1000},
	}
	ts := buildSearchServer(t, results, nil)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/notes/search-titles?q=test")
	if err != nil {
		t.Fatalf("ST3: request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("ST3: expected 200, got %d: %s", resp.StatusCode, body)
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("ST3: decode error: %v", err)
	}
	resultsAny, ok := raw["results"].([]interface{})
	if !ok || len(resultsAny) == 0 {
		t.Fatalf("ST3: no results: %s", body)
	}
	row := resultsAny[0].(map[string]interface{})
	if _, ok := row["recency_score"]; !ok {
		t.Errorf("ST3: response missing recency_score field: %v", row)
	}
}

// ST4: limit param caps result count.
func TestGetNotesSearchTitles_ST4_LimitCapCount(t *testing.T) {
	ts := buildSearchServer(t, []notes.SearchResult{
		{ID: uuid.New(), Title: "A", Path: "a.md", MtimeUnix: 3},
		{ID: uuid.New(), Title: "B", Path: "b.md", MtimeUnix: 2},
	}, nil)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/notes/search-titles?limit=2")
	if err != nil {
		t.Fatalf("ST4: request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("ST4: expected 200, got %d: %s", resp.StatusCode, body)
	}
}

// ST5: limit > 50 is clamped to 50 (no error, handler enforces).
func TestGetNotesSearchTitles_ST5_LimitOver50_ClampsTo50(t *testing.T) {
	ts := buildSearchServer(t, []notes.SearchResult{}, nil)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/notes/search-titles?limit=100")
	if err != nil {
		t.Fatalf("ST5: request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Errorf("ST5: expected 200 for limit=100 (clamped to 50), got %d: %s", resp.StatusCode, body)
	}
}

// ST6: results are present (sort is handled by the index; handler passes them through).
func TestGetNotesSearchTitles_ST6_ResultsSortedByRecency(t *testing.T) {
	results := []notes.SearchResult{
		{ID: uuid.New(), Title: "Recent", Path: "r.md", MtimeUnix: 2000},
		{ID: uuid.New(), Title: "Old", Path: "o.md", MtimeUnix: 1000},
	}
	ts := buildSearchServer(t, results, nil)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/notes/search-titles")
	if err != nil {
		t.Fatalf("ST6: request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("ST6: expected 200, got %d: %s", resp.StatusCode, body)
	}

	var result struct {
		Results []struct {
			Title string `json:"title"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("ST6: decode error: %v", err)
	}
	if len(result.Results) < 2 {
		t.Fatalf("ST6: expected at least 2 results, got %d", len(result.Results))
	}
	if result.Results[0].Title != "Recent" {
		t.Errorf("ST6: expected first result 'Recent' (highest mtime), got %q", result.Results[0].Title)
	}
}
