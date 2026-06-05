package api

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// TestPostFolders_HappyPath_201 — root-level folder creation.
func TestPostFolders_HappyPath_201(t *testing.T) {
	t.Parallel()
	ts, _, root, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/folders",
		`{"parent_path":"","name":"projects"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("status: got %d, want 201; body=%s", resp.StatusCode, body)
	}
	var got FolderNode
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if string(got.Kind) != "folder" {
		t.Errorf("Kind: got %q, want %q", got.Kind, "folder")
	}
	if got.Path != "projects" {
		t.Errorf("Path: got %q, want %q", got.Path, "projects")
	}
	if got.Name != "projects" {
		t.Errorf("Name: got %q, want %q", got.Name, "projects")
	}

	if got.Children == nil {
		t.Errorf("Children: nil, want []TreeNode{}")
	} else if len(*got.Children) != 0 {
		t.Errorf("Children len: got %d, want 0", len(*got.Children))
	}

	info, err := os.Stat(filepath.Join(root, "projects"))
	if err != nil {
		t.Fatalf("dir missing: %v", err)
	}
	if !info.IsDir() {
		t.Errorf("not a dir")
	}
}

// TestPostFolders_NestedParent_201 — folder created inside an existing
// folder.
func TestPostFolders_NestedParent_201(t *testing.T) {
	t.Parallel()
	ts, _, root, _ := setupRealFSServer(t)
	defer ts.Close()
	if err := os.Mkdir(filepath.Join(root, "projects"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	resp, body := mustPostJSON(t, ts, "/api/v1/folders",
		`{"parent_path":"projects","name":"jasper"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("status: got %d; body=%s", resp.StatusCode, body)
	}
	var got FolderNode
	_ = json.Unmarshal(body, &got)
	if got.Path != "projects/jasper" {
		t.Errorf("Path: got %q, want %q", got.Path, "projects/jasper")
	}
	if got.Name != "jasper" {
		t.Errorf("Name: got %q, want %q", got.Name, "jasper")
	}
}

// TestPostFolders_Collision_409 — same name twice → 409 case_collision.
func TestPostFolders_Collision_409(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/folders",
		`{"parent_path":"","name":"projects"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("first POST: %d; body=%s", resp.StatusCode, body)
	}
	resp, body = mustPostJSON(t, ts, "/api/v1/folders",
		`{"parent_path":"","name":"projects"}`)
	if resp.StatusCode != 409 {
		t.Fatalf("second POST: %d, want 409; body=%s", resp.StatusCode, body)
	}
	var got Error
	_ = json.Unmarshal(body, &got)
	if got.Code != "case_collision" {
		t.Errorf("Code: got %q, want %q", got.Code, "case_collision")
	}
}

// TestPostFolders_NameWithSlash_400 — illegal name → 400 invalid_request.
func TestPostFolders_NameWithSlash_400(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/folders",
		`{"parent_path":"","name":"a/b"}`)
	if resp.StatusCode != 400 {
		t.Fatalf("status: %d, want 400; body=%s", resp.StatusCode, body)
	}
	var got Error
	_ = json.Unmarshal(body, &got)
	if got.Code != "invalid_request" {
		t.Errorf("Code: got %q, want %q", got.Code, "invalid_request")
	}
}

// TestDeleteFolder_HappyPath_Empty_204 — empty folder, recursive=false
// → 204.
func TestDeleteFolder_HappyPath_Empty_204(t *testing.T) {
	t.Parallel()
	ts, _, root, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustPostJSON(t, ts, "/api/v1/folders",
		`{"parent_path":"","name":"projects"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d; body=%s", resp.StatusCode, body)
	}

	resp, body = mustDelete(t, ts, "/api/v1/folders?path=projects")
	if resp.StatusCode != 204 {
		t.Fatalf("delete: %d, want 204; body=%s", resp.StatusCode, body)
	}
	if _, err := os.Stat(filepath.Join(root, "projects")); !os.IsNotExist(err) {
		t.Errorf("folder still on disk: %v", err)
	}
}

// TestDeleteFolder_NotEmpty_NoRecursive_409 — folder with a note,
// recursive=false → 409 folder_not_empty.
func TestDeleteFolder_NotEmpty_NoRecursive_409(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()

	if resp, body := mustPostJSON(t, ts, "/api/v1/folders",
		`{"parent_path":"","name":"projects"}`); resp.StatusCode != 201 {
		t.Fatalf("create folder: %d; body=%s", resp.StatusCode, body)
	}
	if resp, body := mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"projects","title":"alpha"}`); resp.StatusCode != 201 {
		t.Fatalf("create note: %d; body=%s", resp.StatusCode, body)
	}

	resp, body := mustDelete(t, ts, "/api/v1/folders?path=projects")
	if resp.StatusCode != 409 {
		t.Fatalf("delete: %d, want 409; body=%s", resp.StatusCode, body)
	}
	var got Error
	_ = json.Unmarshal(body, &got)
	if got.Code != "folder_not_empty" {
		t.Errorf("Code: got %q, want %q", got.Code, "folder_not_empty")
	}
}

// TestDeleteFolder_Recursive_204 — folder with a note, recursive=true
// → 204; folder, note, and index row gone.
func TestDeleteFolder_Recursive_204(t *testing.T) {
	t.Parallel()
	ts, _, root, idx := setupRealFSServer(t)
	defer ts.Close()

	if resp, body := mustPostJSON(t, ts, "/api/v1/folders",
		`{"parent_path":"","name":"projects"}`); resp.StatusCode != 201 {
		t.Fatalf("create folder: %d; body=%s", resp.StatusCode, body)
	}
	if resp, body := mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"projects","title":"alpha"}`); resp.StatusCode != 201 {
		t.Fatalf("create note: %d; body=%s", resp.StatusCode, body)
	}

	resp, body := mustDelete(t, ts, "/api/v1/folders?path=projects&recursive=true")
	if resp.StatusCode != 204 {
		t.Fatalf("delete: %d, want 204; body=%s", resp.StatusCode, body)
	}
	if _, err := os.Stat(filepath.Join(root, "projects")); !os.IsNotExist(err) {
		t.Errorf("folder still on disk: %v", err)
	}
	if _, ok := idx.byPath["projects/alpha.md"]; ok {
		t.Errorf("index row not removed")
	}
}

// TestDeleteFolder_NotFound_404 — DELETE on a non-existent path → 404.
func TestDeleteFolder_NotFound_404(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustDelete(t, ts, "/api/v1/folders?path=nope")

	if resp.StatusCode == 500 {
		t.Errorf("unexpected 500 on missing folder: body=%s", body)
	}
	if resp.StatusCode < 400 || resp.StatusCode >= 500 {
		t.Errorf("status: %d, want 4xx; body=%s", resp.StatusCode, body)
	}
}

// TestDeleteFolder_PathEscape_400 — path=../x → 400 invalid_path.
func TestDeleteFolder_PathEscape_400(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()

	resp, body := mustDelete(t, ts, "/api/v1/folders?path="+url.QueryEscape("../x"))
	if resp.StatusCode != 400 {
		t.Fatalf("status: %d, want 400; body=%s", resp.StatusCode, body)
	}
	var got Error
	_ = json.Unmarshal(body, &got)
	if got.Code != "invalid_path" {
		t.Errorf("Code: got %q, want %q", got.Code, "invalid_path")
	}
}

// TestPostFolderMove_HappyPath_200 — move folder → 200 FolderNode.
func TestPostFolderMove_HappyPath_200(t *testing.T) {
	t.Parallel()
	ts, _, root, idx := setupRealFSServer(t)
	defer ts.Close()

	if resp, body := mustPostJSON(t, ts, "/api/v1/folders",
		`{"parent_path":"","name":"old"}`); resp.StatusCode != 201 {
		t.Fatalf("create folder: %d; body=%s", resp.StatusCode, body)
	}
	if resp, body := mustPostJSON(t, ts, "/api/v1/notes",
		`{"parent_path":"old","title":"alpha"}`); resp.StatusCode != 201 {
		t.Fatalf("create note: %d; body=%s", resp.StatusCode, body)
	}

	resp, body := mustPostJSON(t, ts, "/api/v1/folders/move",
		`{"old_path":"old","new_path":"new"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d, want 200; body=%s", resp.StatusCode, body)
	}
	var got FolderNode
	_ = json.Unmarshal(body, &got)
	if got.Path != "new" {
		t.Errorf("Path: got %q, want %q", got.Path, "new")
	}
	if got.Name != "new" {
		t.Errorf("Name: got %q, want %q", got.Name, "new")
	}
	if string(got.Kind) != "folder" {
		t.Errorf("Kind: got %q, want %q", got.Kind, "folder")
	}

	if _, err := os.Stat(filepath.Join(root, "new", "alpha.md")); err != nil {
		t.Errorf("file not at new path: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "old")); !os.IsNotExist(err) {
		t.Errorf("old dir still exists: %v", err)
	}
	if _, ok := idx.byPath["new/alpha.md"]; !ok {
		t.Errorf("index row not re-prefixed; idx=%v", idx.byPath)
	}
}

// TestPostFolderMove_Cycle_400 — move into own descendant → 400 cycle.
func TestPostFolderMove_Cycle_400(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()
	if resp, body := mustPostJSON(t, ts, "/api/v1/folders",
		`{"parent_path":"","name":"x"}`); resp.StatusCode != 201 {
		t.Fatalf("create: %d; body=%s", resp.StatusCode, body)
	}
	resp, body := mustPostJSON(t, ts, "/api/v1/folders/move",
		`{"old_path":"x","new_path":"x/y"}`)
	if resp.StatusCode != 400 {
		t.Fatalf("status: %d, want 400; body=%s", resp.StatusCode, body)
	}
	var got Error
	_ = json.Unmarshal(body, &got)
	if got.Code != "cycle" {
		t.Errorf("Code: got %q, want %q", got.Code, "cycle")
	}
}

// TestPostFolderMove_Collision_409 — move into occupied path → 409.
func TestPostFolderMove_Collision_409(t *testing.T) {
	t.Parallel()
	ts, _, _, _ := setupRealFSServer(t)
	defer ts.Close()
	if resp, body := mustPostJSON(t, ts, "/api/v1/folders",
		`{"parent_path":"","name":"a"}`); resp.StatusCode != 201 {
		t.Fatalf("create a: %d; body=%s", resp.StatusCode, body)
	}
	if resp, body := mustPostJSON(t, ts, "/api/v1/folders",
		`{"parent_path":"","name":"b"}`); resp.StatusCode != 201 {
		t.Fatalf("create b: %d; body=%s", resp.StatusCode, body)
	}
	resp, body := mustPostJSON(t, ts, "/api/v1/folders/move",
		`{"old_path":"a","new_path":"b"}`)
	if resp.StatusCode != 409 {
		t.Fatalf("status: %d, want 409; body=%s", resp.StatusCode, body)
	}
	var got Error
	_ = json.Unmarshal(body, &got)
	if got.Code != "case_collision" {
		t.Errorf("Code: got %q, want %q", got.Code, "case_collision")
	}
}

var _ = http.StatusOK
