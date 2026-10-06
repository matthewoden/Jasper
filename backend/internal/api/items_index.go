package api

import (
	"context"

	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// itemsIndex is what the item handlers read beyond notes.Index: attachments
// and a note's outgoing references. Nil when the server has no index.
type itemsIndex interface {
	AdoptAttachment(ctx context.Context, relPath string) (string, error)
	GetBlob(ctx context.Context, id string) (index.Blob, bool, error)
	RefsBySource(ctx context.Context, sourceID notes.ID) ([]index.NoteRef, error)
	SearchBlobNames(ctx context.Context, q string, limit int) ([]index.BlobHit, error)
}

// itemsIndexOf is the concrete indexer behind idx, or nil, never a typed nil.
func itemsIndexOf(idx notes.Index) itemsIndex {
	if x, ok := idx.(*index.Indexer); ok && x != nil {
		return x
	}
	return nil
}
