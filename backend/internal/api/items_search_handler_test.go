package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/matthewoden/jasper/backend/internal/index"
)

func serveReal(t *testing.T, srv *Server) *httptest.Server {
	t.Helper()
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		Mount(si, r)
	})
	ts := httptest.NewServer(r)
	t.Cleanup(ts.Close)
	return ts
}

func TestItemsSearchAndBlobStream(t *testing.T) {
	srv := newSearchTestServer(t, []seedNote{
		{Path: "roadmap.md", Body: "# Roadmap\n\nbody"},
		{Path: "other.md", Body: "# Other\n\nbody"},
	})
	notesDir := srv.notesRoot()
	attach := filepath.Join(notesDir, "attachments")
	if err := os.MkdirAll(attach, 0o755); err != nil {
		t.Fatal(err)
	}
	png := []byte("\x89PNG\r\n\x1a\nroadmap screenshot")
	if err := os.WriteFile(filepath.Join(attach, "roadmap.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}
	idx := srv.index.(*index.Indexer)
	if _, err := idx.Reconcile(context.Background(), index.ModeIncremental); err != nil {
		t.Fatal(err)
	}
	ts := serveReal(t, srv)

	resp, err := http.Get(ts.URL + "/api/v1/items/search?q=roadmap")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("search: %d %s", resp.StatusCode, body)
	}
	var got ItemSearchResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Items) != 2 {
		t.Fatalf("items = %+v, want the note and the blob", got.Items)
	}
	note, blob := got.Items[0], got.Items[1]
	if note.Kind != "note" || note.Title != "Roadmap" || !strings.HasPrefix(note.Ref, "jasper:note/") {
		t.Errorf("note hit = %+v", note)
	}
	if blob.Kind != "blob" || blob.Title != "roadmap.png" || !strings.HasPrefix(blob.Ref, "jasper:blob/sha256-") || blob.Path != "attachments/roadmap.png" {
		t.Errorf("blob hit = %+v", blob)
	}

	blobID := strings.TrimPrefix(blob.Ref, "jasper:blob/")
	resp, err = http.Get(ts.URL + "/api/v1/blobs/" + blobID)
	if err != nil {
		t.Fatal(err)
	}
	streamed, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || !bytes.Equal(streamed, png) {
		t.Errorf("blob stream: %d, %d bytes", resp.StatusCode, len(streamed))
	}
	resp, _ = http.Get(ts.URL + "/api/v1/blobs/sha256-0000000000000000")
	_ = resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Errorf("unknown blob: %d", resp.StatusCode)
	}
	resp, _ = http.Get(ts.URL + "/api/v1/items/search?q=")
	all, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var listed ItemSearchResponse
	_ = json.Unmarshal(all, &listed)
	if len(listed.Items) != 2 || listed.Items[0].Kind != "note" || listed.Items[1].Kind != "note" {
		t.Errorf("empty query = %+v, want recent notes only", listed.Items)
	}
}

func TestCreateAttachment_ReturnsBlobID(t *testing.T) {
	srv := newSearchTestServer(t, []seedNote{{Path: "host.md", Body: "# Host\n"}})
	ts := serveReal(t, srv)
	resp, err := http.Get(ts.URL + "/api/v1/tree")
	if err != nil {
		t.Fatal(err)
	}
	treeBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var tree struct {
		Root []struct {
			Kind string `json:"kind"`
			ID   string `json:"id"`
		} `json:"root"`
	}
	_ = json.Unmarshal(treeBody, &tree)
	var noteID string
	for _, n := range tree.Root {
		if n.Kind == "note" {
			noteID = n.ID
		}
	}
	if noteID == "" {
		t.Fatalf("no note in tree: %s", treeBody)
	}

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, _ := mw.CreateFormFile("file", "shot.png")
	content := []byte("\x89PNG\r\n\x1a\nuploaded bytes")
	_, _ = part.Write(content)
	_ = mw.Close()
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/attachments/"+noteID, &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("upload: %d %s", resp.StatusCode, body)
	}
	var up AttachmentUploadResult
	_ = json.Unmarshal(body, &up)
	if up.BlobId == nil || !strings.HasPrefix(*up.BlobId, "sha256-") {
		t.Fatalf("upload result lacks blob_id: %s", body)
	}
	idx := srv.index.(*index.Indexer)
	b, ok, err := idx.GetBlob(context.Background(), *up.BlobId)
	if err != nil || !ok || len(b.Paths) != 1 || b.Paths[0] != "attachments/shot.png" {
		t.Errorf("adopted blob = %+v, %v, %v", b, ok, err)
	}
	resp, _ = http.Get(ts.URL + "/api/v1/blobs/" + *up.BlobId)
	streamed, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if !bytes.Equal(streamed, content) {
		t.Errorf("stream by id returned %d bytes", len(streamed))
	}
}

func TestGetNoteRefs(t *testing.T) {
	srv := newSearchTestServer(t, []seedNote{
		{Path: "target.md", Body: "# Target\n"},
		{Path: "source.md", Body: "---\nrefs: [bt:task/9]\n---\n# Source\n\n[[Target]] [[ado:workitem/12345|the ticket]] [[ado:workitem/12345]] [[Nowhere]]\n"},
	})
	srv.hydrateRegistryFromIndex(context.Background())
	idx := srv.index.(*index.Indexer)
	if err := idx.ResolvePendingBacklinks(context.Background(), srv.notes.Registry()); err != nil {
		t.Fatal(err)
	}
	ts := serveReal(t, srv)

	ids := map[string]string{}
	resp, _ := http.Get(ts.URL + "/api/v1/tree")
	treeBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var tree struct {
		Root []struct {
			Kind string `json:"kind"`
			ID   string `json:"id"`
			Path string `json:"path"`
		} `json:"root"`
	}
	_ = json.Unmarshal(treeBody, &tree)
	for _, n := range tree.Root {
		if n.Kind == "note" {
			ids[n.Path] = n.ID
		}
	}

	resp, err := http.Get(ts.URL + "/api/v1/notes/" + ids["source.md"] + "/refs")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("refs: %d %s", resp.StatusCode, body)
	}
	var got NoteRefsResponse
	_ = json.Unmarshal(body, &got)
	var targets []string
	for _, r := range got.Refs {
		targets = append(targets, r.TargetRef+"|"+r.Display)
	}
	want := []string{"bt:task/9|", "jasper:note/" + ids["target.md"] + "|", "ado:workitem/12345|the ticket", "jasper:title/Nowhere|"}
	if strings.Join(targets, ",") != strings.Join(want, ",") {
		t.Errorf("refs = %v, want %v", targets, want)
	}
	if got.Refs[0].Position != -1 || got.Refs[1].Position < 0 {
		t.Errorf("positions = %+v", got.Refs)
	}

	resp, _ = http.Get(ts.URL + "/api/v1/notes/01ARZ3NDEKTSV4RRFFQ69G5FAV/refs")
	_ = resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Errorf("unknown note: %d", resp.StatusCode)
	}
}
