package api

import (
	"context"
	"errors"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/matthewoden/jasper/backend/internal/index"
)

// GetTree implements GET /api/v1/tree.
//
// Translation goes through the generated FromFolderNode / FromNoteNode helpers
// — the only safe way to populate the discriminated TreeNode oneOf. The wire
// shape is a strict subset of NoteRecord: checksum_sha256, size_bytes,
// mtime_unix and updated_at_unix never ship.
//
//nolint:revive // generated interface name
func (s *Server) GetTree(
	ctx context.Context,
	_ GetTreeRequestObject,
) (GetTreeResponseObject, error) {
	if s.index == nil {
		return GetTree200JSONResponse{Root: []TreeNode{}}, nil
	}
	idx, ok := s.index.(*index.Indexer)
	if !ok || idx == nil {
		return GetTree200JSONResponse{Root: []TreeNode{}}, nil
	}
	t, err := idx.BuildTree(ctx)
	if err != nil {
		s.log.Error("GetTree: BuildTree failed", "err", err)
		return nil, errors.New("could not build tree")
	}
	return GetTree200JSONResponse(translateTreeToWire(t)), nil
}

func translateTreeToWire(t *index.Tree) Tree {
	if t == nil {
		return Tree{Root: []TreeNode{}}
	}
	out := Tree{Root: make([]TreeNode, 0, len(t.Root))}
	for _, n := range t.Root {
		out.Root = append(out.Root, translateNodeToWire(n))
	}
	return out
}

func translateNodeToWire(n index.TreeNode) TreeNode {
	if n.Folder != nil {
		kids := make([]TreeNode, 0, len(n.Folder.Children))
		for _, c := range n.Folder.Children {
			kids = append(kids, translateNodeToWire(c))
		}
		folder := FolderNode{
			Kind:     FolderNodeKind("folder"),
			Path:     n.Folder.Path,
			Name:     n.Folder.Name,
			Children: &kids,
		}
		var wire TreeNode
		_ = wire.FromFolderNode(folder)
		return wire
	}
	if n.Note != nil {
		created := n.Note.Created
		note := NoteNode{
			Kind:      NoteNodeKind("note"),
			Id:        openapi_types.UUID(n.Note.ID),
			Path:      n.Note.Path,
			Title:     n.Note.Title,
			UpdatedAt: n.Note.UpdatedAt,
			Created:   &created,
		}
		var wire TreeNode
		_ = wire.FromNoteNode(note)
		return wire
	}
	if n.File != nil {
		file := FileNode{
			Kind: FileNodeKind("file"),
			Path: n.File.Path,
			Name: n.File.Name,
		}
		var wire TreeNode
		_ = wire.FromFileNode(file)
		return wire
	}
	return TreeNode{}
}
