package mcp_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/markdown"
	"github.com/matthewoden/jasper/backend/internal/mcp"
	"github.com/matthewoden/jasper/backend/internal/notes"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestCreateNote_OptionalID(t *testing.T) {
	t.Parallel()
	f := newTestServer(t)
	if _, err := f.ACL.Set(context.Background(), "projects", mcp.TierEditOnly, "test"); err != nil {
		t.Fatalf("Set grant: %v", err)
	}
	id := notes.NewID()

	res, err := f.callTool(t, "create_note", map[string]any{"path": "projects/chosen.md", "id": id.String()})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", flattenContent(res))
	}
	data, err := os.ReadFile(filepath.Join(f.Root, "projects", "chosen.md"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if raw, _ := markdown.ReadID(data); raw != id.String() {
		t.Errorf("file id %q, want %s", raw, id)
	}
	if !strings.Contains(flattenContent(res), id.String()) {
		t.Errorf("result does not report the id: %s", flattenContent(res))
	}

	res, err = f.callTool(t, "create_note", map[string]any{"path": "projects/again.md", "id": id.String()})
	if err == nil && !res.IsError {
		t.Fatalf("reusing an id succeeded")
	}
	if msg := errText(res, err); !strings.Contains(msg, "id_taken") {
		t.Errorf("reuse error = %q, want id_taken", msg)
	}

	res, err = f.callTool(t, "create_note", map[string]any{"path": "projects/bad.md", "id": "not-a-ulid"})
	if err == nil && !res.IsError {
		t.Fatalf("malformed id succeeded")
	}
	if msg := errText(res, err); !strings.Contains(msg, "invalid_id") {
		t.Errorf("malformed error = %q, want invalid_id", msg)
	}
	if _, statErr := os.Stat(filepath.Join(f.Root, "projects", "bad.md")); statErr == nil {
		t.Errorf("a rejected create left a file behind")
	}
}

// errText is the failure a caller sees, whichever channel carried it.
func errText(res *mcpsdk.CallToolResult, err error) string {
	if err != nil {
		return err.Error()
	}
	return flattenContent(res)
}
