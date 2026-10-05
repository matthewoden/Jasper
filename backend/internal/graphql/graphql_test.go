package graphql_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/graphql"
	"github.com/matthewoden/jasper/backend/internal/graphql/model"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/migrations"
)

type fixture struct {
	svc      *notes.Service
	idx      *index.Indexer
	events   *graphql.Events
	notesDir string
	ts       *httptest.Server
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	notesDir := filepath.Join(root, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".trash"), 0o755); err != nil {
		t.Fatal(err)
	}
	pair, err := sqlite.Open(context.Background(), filepath.Join(root, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pair.Close() })
	names, _ := fs.ReadDir(migrations.FS, ".")
	sort.Slice(names, func(i, j int) bool { return names[i].Name() < names[j].Name() })
	for _, e := range names {
		data, _ := migrations.FS.ReadFile(e.Name())
		if _, err := pair.Writer.ExecContext(context.Background(), string(data)); err != nil {
			t.Fatalf("apply %s: %v", e.Name(), err)
		}
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idx := index.New(pair, notesDir, logger)
	events := graphql.NewEvents(nil)
	svc := notes.NewService(fsstore.NewStore(notesDir), idx, events, logger)
	h := graphql.NewHandler(&graphql.Resolver{Notes: svc, Index: idx, Blobs: idx, Events: events, Log: logger}, []string{"127.0.0.1:*"})
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	return &fixture{svc: svc, idx: idx, events: events, notesDir: notesDir, ts: ts}
}

func (f *fixture) reindex(t *testing.T) {
	t.Helper()
	if _, err := f.idx.Reconcile(context.Background(), index.ModeFull); err != nil {
		t.Fatal(err)
	}
	summaries, _ := f.idx.List(context.Background())
	f.svc.Registry().Hydrate(summaries)
	if err := f.idx.ResolvePendingBacklinks(context.Background(), f.svc.Registry()); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) write(t *testing.T, rel, content string) {
	t.Helper()
	full := filepath.Join(f.notesDir, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) idOf(t *testing.T, rel string) notes.ID {
	t.Helper()
	data, _ := os.ReadFile(filepath.Join(f.notesDir, rel))
	raw, _ := markdown.ReadID(data)
	id, err := notes.ParseID(raw)
	if err != nil {
		t.Fatalf("%s: %v", rel, err)
	}
	return id
}

func (f *fixture) query(t *testing.T, q string, vars map[string]any) map[string]any {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"query": q, "variables": vars})
	resp, err := http.Post(f.ts.URL+"/graphql", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	var out struct {
		Data   map[string]any `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("bad response %d: %s", resp.StatusCode, raw)
	}
	if len(out.Errors) > 0 {
		t.Fatalf("graphql errors: %+v\n%s", out.Errors, raw)
	}
	return out.Data
}

const itemFields = `id kind status title updatedAt ... on Note { path excerpt refs backlinks { source { id title } display embed } } ... on Blob { paths mime replacedBy } ... on ForeignRef { namespace }`

// Criteria 2 and 9: a note resolves by id in every spelling, keeps its id
// across a move, and a deleted note is DELETED with its last title.
func TestItemResolution(t *testing.T) {
	f := newFixture(t)
	f.write(t, "alpha.md", "---\ntags: []\n---\n# Alpha\n\nThe body. See [[Beta]] and [[ado:workitem/42|ticket]].\n")
	f.write(t, "beta.md", "# Beta\n")
	f.write(t, "attachments/shot.png", "\x89PNG bytes")
	f.reindex(t)
	alpha, beta := f.idOf(t, "alpha.md"), f.idOf(t, "beta.md")
	ctx := context.Background()

	for _, id := range []string{alpha.String(), notes.RefForNote(alpha), "jasper:title/Alpha"} {
		data := f.query(t, `query($id: ID!) { item(id: $id) { `+itemFields+` ... on Note { body } } }`, map[string]any{"id": id})
		item, _ := data["item"].(map[string]any)
		if item == nil || item["id"] != notes.RefForNote(alpha) || item["status"] != "OK" || item["title"] != "Alpha" || item["kind"] != "NOTE" {
			t.Fatalf("item(%s) = %+v", id, item)
		}
		if !strings.Contains(item["body"].(string), "The body.") || item["path"] != "alpha.md" || !strings.HasPrefix(item["excerpt"].(string), "Alpha The body") {
			t.Errorf("item(%s) detail = %+v", id, item)
		}
		refs, _ := item["refs"].([]any)
		if len(refs) != 2 || refs[0] != notes.RefForNote(beta) || refs[1] != "ado:workitem/42" {
			t.Errorf("refs = %v", refs)
		}
	}

	// Beta is referenced by Alpha through a title link.
	data := f.query(t, `query($id: ID!) { item(id: $id) { ... on Note { backlinks { source { id title } display } } } backlinks(id: $id) { source { title } } }`, map[string]any{"id": beta.String()})
	item := data["item"].(map[string]any)
	bl := item["backlinks"].([]any)
	if len(bl) != 1 || bl[0].(map[string]any)["source"].(map[string]any)["title"] != "Alpha" {
		t.Errorf("beta backlinks = %v", bl)
	}
	if top := data["backlinks"].([]any); len(top) != 1 {
		t.Errorf("Query.backlinks = %v", top)
	}

	// A move keeps the id and item(id) answers with the new path.
	if _, err := f.svc.CreateFolder(ctx, "", "moved"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Move(ctx, alpha, "moved/alpha.md"); err != nil {
		t.Fatal(err)
	}
	data = f.query(t, `query($id: ID!) { item(id: $id) { ... on Note { id path } } }`, map[string]any{"id": alpha.String()})
	if item := data["item"].(map[string]any); item["path"] != "moved/alpha.md" || item["id"] != notes.RefForNote(alpha) {
		t.Errorf("after move = %+v", item)
	}

	// Foreign, blob, unknown and deleted.
	blob := func() string {
		b, _, _ := f.idx.BlobAtPath(ctx, "attachments/shot.png")
		return b.ID
	}()
	if err := f.svc.Delete(ctx, beta); err != nil {
		t.Fatal(err)
	}
	data = f.query(t, `query($ids: [ID!]!) { items(ids: $ids) { `+itemFields+` } }`, map[string]any{
		"ids": []string{"ado:workitem/42", notes.RefForBlob(blob), blob, notes.RefForNote(notes.NewID()), beta.String(), "jasper:title/Nobody"},
	})
	items := data["items"].([]any)
	if len(items) != 6 {
		t.Fatalf("items = %v", items)
	}
	foreign := items[0].(map[string]any)
	if foreign["kind"] != "FOREIGN" || foreign["status"] != "UNKNOWN" || foreign["namespace"] != "ado" || foreign["title"] != "ado:workitem/42" {
		t.Errorf("foreign = %+v", foreign)
	}
	for _, i := range []int{1, 2} {
		b := items[i].(map[string]any)
		if b["kind"] != "BLOB" || b["status"] != "OK" || b["title"] != "shot.png" || b["mime"] != "image/png" || b["id"] != notes.RefForBlob(blob) {
			t.Errorf("blob[%d] = %+v", i, b)
		}
	}
	if items[3] != nil || items[5] != nil {
		t.Errorf("unknown items = %v %v, want null", items[3], items[5])
	}
	deleted := items[4].(map[string]any)
	if deleted["status"] != "DELETED" || deleted["title"] != "Beta" || deleted["path"] != "beta.md" || deleted["updatedAt"] == nil {
		t.Errorf("deleted = %+v", deleted)
	}
	data = f.query(t, `query($id: ID!) { item(id: $id) { ... on Note { body } } }`, map[string]any{"id": beta.String()})
	if body := data["item"].(map[string]any)["body"]; body != nil {
		t.Errorf("deleted note body = %v, want null", body)
	}
}

func TestSearchItems(t *testing.T) {
	f := newFixture(t)
	f.write(t, "roadmap.md", "# Roadmap\n\nplanning the quarter\n")
	f.write(t, "notes.md", "# Notes\n\nnothing about plans\n")
	f.write(t, "attachments/roadmap-chart.png", "png")
	f.reindex(t)

	data := f.query(t, `query($q: String!) { searchItems(q: $q, limit: 10) { id kind title } }`, map[string]any{"q": "roadmap"})
	hits := data["searchItems"].([]any)
	var got []string
	for _, h := range hits {
		m := h.(map[string]any)
		got = append(got, m["kind"].(string)+":"+m["title"].(string))
	}
	if strings.Join(got, ",") != "NOTE:Roadmap,BLOB:roadmap-chart.png" {
		t.Errorf("searchItems = %v", got)
	}
	data = f.query(t, `query { searchItems(q: "") { kind } }`, nil)
	if n := len(data["searchItems"].([]any)); n != 2 {
		t.Errorf("empty query = %d items, want the two notes", n)
	}
	data = f.query(t, `query { searchItems(q: "\"unbalanced") { kind title } }`, nil)
	if _, ok := data["searchItems"].([]any); !ok {
		t.Errorf("malformed FTS query should fall back, got %v", data)
	}
}

func TestFederationServiceAndEntities(t *testing.T) {
	f := newFixture(t)
	f.write(t, "alpha.md", "# Alpha\n")
	f.reindex(t)
	alpha := f.idOf(t, "alpha.md")

	data := f.query(t, `{ _service { sdl } }`, nil)
	sdl := data["_service"].(map[string]any)["sdl"].(string)
	for _, want := range []string{"interface Item", "type Note implements Item @key(fields: \"id\")", "type Blob implements Item @key(fields: \"id\")", "type ForeignRef implements Item"} {
		if !strings.Contains(sdl, want) {
			t.Errorf("sdl lacks %q", want)
		}
	}
	if strings.Contains(sdl, "interface Item @key") {
		t.Errorf("Item must be a value interface, not an entity interface")
	}

	data = f.query(t, `query($reps: [_Any!]!) { _entities(representations: $reps) { ... on Note { id title } ... on Blob { id } } }`, map[string]any{
		"reps": []map[string]any{
			{"__typename": "Note", "id": notes.RefForNote(alpha)},
			{"__typename": "Note", "id": notes.RefForNote(notes.NewID())},
		},
	})
	ents := data["_entities"].([]any)
	if len(ents) != 2 || ents[0].(map[string]any)["title"] != "Alpha" || ents[1] != nil {
		t.Errorf("_entities = %v", ents)
	}
}

func TestNoGetTransport(t *testing.T) {
	f := newFixture(t)
	resp, err := http.Get(f.ts.URL + "/graphql?query=%7B__typename%7D")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Errorf("a GET query was served; status %d", resp.StatusCode)
	}
}

func TestEvents(t *testing.T) {
	events := graphql.NewEvents(nil)
	ch, unsubscribe := events.Subscribe()
	defer unsubscribe()
	id := notes.NewID()

	events.Broadcast(notes.EventNoteUpdated, map[string]any{"id": id.String(), "path": "a.md"}, "s1")
	events.Broadcast(notes.EventRefsChanged, map[string]any{"source_id": id.String(), "added": []string{}}, "s1")
	events.Broadcast(notes.EventTagsUpdated, map[string]any{"note_id": id.String()}, "s1")

	got := []*model.ItemChange{<-ch, <-ch}
	if got[0].ID != notes.RefForNote(id) || got[0].Change != model.ItemChangeKindUpdated || got[1].Change != model.ItemChangeKindRefsChanged || got[0].At.IsZero() {
		t.Errorf("changes = %+v %+v", got[0], got[1])
	}
	select {
	case extra := <-ch:
		t.Errorf("unexpected change %+v", extra)
	default:
	}

	// A subscriber that never reads loses changes instead of blocking.
	slow, stop := events.Subscribe()
	for i := 0; i < 100; i++ {
		events.Broadcast(notes.EventNoteCreated, map[string]any{"id": id.String()}, "")
	}
	if len(slow) != cap(slow) {
		t.Errorf("slow subscriber buffer = %d", len(slow))
	}
	stop()
	if _, open := <-slow; open && len(slow) == 0 {
		t.Errorf("channel not closed after unsubscribe")
	}
}
