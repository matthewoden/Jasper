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
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// refsIdx answers ref backlinks and item lookups from fixtures; everything
// else is the backlinks fake underneath.
type refsIdx struct {
	*blIdx
	backlinksByRef map[string][]notes.RefBacklink
	items          map[string]notes.ItemInfo
	lookedUp       []string
}

func (f *refsIdx) RefBacklinks(_ context.Context, target string) ([]notes.RefBacklink, error) {
	if rows, ok := f.backlinksByRef[target]; ok {
		return rows, nil
	}
	return []notes.RefBacklink{}, nil
}

func (f *refsIdx) LookupItem(_ context.Context, id string) (notes.ItemInfo, error) {
	f.lookedUp = append(f.lookedUp, id)
	if info, ok := f.items[id]; ok {
		return info, nil
	}
	return notes.ItemInfo{ID: id, Kind: notes.ItemKindNote, Status: notes.ItemStatusUnknown, Title: id}, nil
}

func TestGetRefBacklinks(t *testing.T) {
	src := notes.NewID()
	idx := &refsIdx{blIdx: newBlIdx(), backlinksByRef: map[string][]notes.RefBacklink{
		"ado:workitem/12345": {{SourceID: src, SourceTitle: "Source", SourcePath: "s.md", Display: "the ticket", Embed: false}},
	}}
	ts := setupBLServer(t, idx)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/refs/backlinks?id=ado%3Aworkitem%2F12345")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	var got RefBacklinksResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Backlinks) != 1 || got.Backlinks[0].SourceId != src.String() || got.Backlinks[0].Display != "the ticket" || got.Backlinks[0].SourcePath != "s.md" {
		t.Errorf("backlinks = %+v", got.Backlinks)
	}

	resp2, _ := http.Get(ts.URL + "/api/v1/refs/backlinks?id=nothing%3Ahere%2F1")
	body2, _ := io.ReadAll(resp2.Body)
	_ = resp2.Body.Close()
	if resp2.StatusCode != 200 || strings.TrimSpace(string(body2)) != `{"backlinks":[]}` {
		t.Errorf("unknown target: %d %s", resp2.StatusCode, body2)
	}
}

func TestPostItemsBatch(t *testing.T) {
	noteID := notes.NewID()
	when := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	idx := &refsIdx{blIdx: newBlIdx(), items: map[string]notes.ItemInfo{
		notes.RefForNote(noteID): {ID: notes.RefForNote(noteID), Kind: notes.ItemKindNote, Status: notes.ItemStatusOK, Title: "Alpha", Path: "a.md", UpdatedAt: when, Excerpt: "Alpha body"},
		"jasper:blob/sha256-00":  {ID: "jasper:blob/sha256-00", Kind: notes.ItemKindBlob, Status: notes.ItemStatusDeleted, Title: "pic.png", Path: "attachments/pic.png", UpdatedAt: when, ReplacedBy: "sha256-11"},
	}}
	ts := setupBLServer(t, idx)
	defer ts.Close()

	ids := []string{notes.RefForNote(noteID), "jasper:blob/sha256-00", "ado:workitem/12345", "jasper:title/Nowhere", notes.NewID().String()}
	resp, body := mustPostJSON(t, ts, "/api/v1/items/batch", fmt.Sprintf(`{"ids":["%s"]}`, strings.Join(ids, `","`)))
	if resp.StatusCode != 200 {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	var got ItemsBatchResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Items) != len(ids) {
		t.Fatalf("items = %+v", got.Items)
	}
	type row struct{ id, kind, status, title string }
	var rows []row
	for _, it := range got.Items {
		rows = append(rows, row{it.Id, string(it.Kind), string(it.Status), it.Title})
	}
	want := []row{
		{ids[0], "note", "OK", "Alpha"},
		{ids[1], "blob", "DELETED", "pic.png"},
		{ids[2], "foreign", "UNKNOWN", "ado:workitem/12345"},
		{ids[3], "note", "UNKNOWN", "Nowhere"},
		{ids[4], "note", "UNKNOWN", ids[4]},
	}
	for i := range want {
		if rows[i] != want[i] {
			t.Errorf("item %d = %+v, want %+v", i, rows[i], want[i])
		}
	}
	if got.Items[0].Excerpt == nil || *got.Items[0].Excerpt != "Alpha body" || got.Items[0].Path == nil || got.Items[0].UpdatedAt == nil {
		t.Errorf("note item lacks detail: %+v", got.Items[0])
	}
	if got.Items[1].ReplacedBy == nil || *got.Items[1].ReplacedBy != "sha256-11" {
		t.Errorf("deleted blob lacks replaced_by: %+v", got.Items[1])
	}
	if got.Items[2].Path != nil || got.Items[2].UpdatedAt != nil {
		t.Errorf("foreign stub carries detail: %+v", got.Items[2])
	}
	for _, id := range idx.lookedUp {
		if strings.HasPrefix(id, "ado:") || strings.HasPrefix(id, "jasper:title/") {
			t.Errorf("foreign or title ref reached the index: %s", id)
		}
	}

	tooMany := make([]string, itemsBatchMax+1)
	for i := range tooMany {
		tooMany[i] = "x"
	}
	resp, body = mustPostJSON(t, ts, "/api/v1/items/batch", fmt.Sprintf(`{"ids":["%s"]}`, strings.Join(tooMany, `","`)))
	if resp.StatusCode != 400 {
		t.Errorf("over the batch limit: %d %s", resp.StatusCode, body)
	}
	resp, body = mustPostJSON(t, ts, "/api/v1/items/batch", `{"ids":[]}`)
	if resp.StatusCode != 200 || strings.TrimSpace(string(body)) != `{"items":[]}` {
		t.Errorf("empty batch: %d %s", resp.StatusCode, body)
	}
}

// A title that resolves comes back as the note it names.
func TestPostItemsBatch_TitleResolvesThroughRegistry(t *testing.T) {
	noteID := notes.NewID()
	idx := &refsIdx{blIdx: newBlIdx(), items: map[string]notes.ItemInfo{
		noteID.String(): {ID: noteID.String(), Kind: notes.ItemKindNote, Status: notes.ItemStatusOK, Title: "Alpha", Path: "alpha.md"},
	}}
	ts, svc := setupBLServerWithService(t, idx)
	defer ts.Close()
	svc.Registry().AddRecord(noteID, "alpha.md", "alpha")

	resp, body := mustPostJSON(t, ts, "/api/v1/items/batch", `{"ids":["jasper:title/Alpha"]}`)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	var got ItemsBatchResponse
	_ = json.Unmarshal(body, &got)
	if len(got.Items) != 1 || got.Items[0].Id != "jasper:title/Alpha" || got.Items[0].Status != "OK" || got.Items[0].Title != "Alpha" {
		t.Errorf("items = %+v", got.Items)
	}
}

func setupBLServerWithService(t *testing.T, idx notes.Index) (*httptest.Server, *notes.Service) {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := notes.NewService(&fakeFileStore{}, nil, nil, logger)
	srv := NewServerWithIndex(svc, nil, nil, idx, nil, logger, "")
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		Mount(si, r)
	})
	return httptest.NewServer(r), svc
}
