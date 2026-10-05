package mcp_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/mcp"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

func structured(t *testing.T, res any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		StructuredContent map[string]any `json:"structuredContent"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out.StructuredContent
}

func TestReadNoteCarriesRefs_AndBacklinksTool(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
		t.Fatal(err)
	}
	created, err := f.callTool(t, "create_note", map[string]any{"path": "projects/refs.md", "body": "See [[ado:workitem/12345|ticket]]."})
	if err != nil || created.IsError {
		t.Fatalf("create_note: %v %v", err, flattenContent(created))
	}
	noteID := structured(t, created)["id"].(string)
	src, _ := notes.ParseID(noteID)

	var askedFor []string
	f.Server.SetRefsProvider(mcp.NewRefsAdapter(
		func(_ context.Context, _ notes.ID) ([]string, error) {
			return []string{"ado:workitem/12345", notes.RefForNote(notes.NewID())}, nil
		},
		func(_ context.Context, target string) ([]notes.RefBacklink, error) {
			askedFor = append(askedFor, target)
			return []notes.RefBacklink{{SourceID: src, SourceTitle: "refs", SourcePath: "projects/refs.md", Display: "ticket"}}, nil
		},
	))

	read, err := f.callTool(t, "read_note", map[string]any{"id": noteID})
	if err != nil || read.IsError {
		t.Fatalf("read_note: %v %v", err, flattenContent(read))
	}
	refs, _ := structured(t, read)["refs"].([]any)
	if len(refs) != 2 || refs[0] != "ado:workitem/12345" {
		t.Errorf("read_note refs = %v", refs)
	}

	for _, target := range []string{"ado:workitem/12345", noteID, "sha256-0123456789abcdef", "jasper:title/refs"} {
		res, err := f.callTool(t, "backlinks", map[string]any{"id": target})
		if err != nil || res.IsError {
			t.Fatalf("backlinks(%s): %v %v", target, err, flattenContent(res))
		}
		got := structured(t, res)
		rows, _ := got["backlinks"].([]any)
		if len(rows) != 1 || rows[0].(map[string]any)["id"] != noteID || rows[0].(map[string]any)["display"] != "ticket" {
			t.Errorf("backlinks(%s) = %v", target, got)
		}
	}
	if strings.Join(askedFor, ",") != "ado:workitem/12345,"+notes.RefForNote(src)+",jasper:blob/sha256-0123456789abcdef,"+notes.RefForNote(src) {
		t.Errorf("targets resolved as %v", askedFor)
	}

	res, err := f.callTool(t, "backlinks", map[string]any{"id": "not a ref"})
	if err == nil && !res.IsError {
		t.Errorf("a malformed target was accepted")
	}
}
