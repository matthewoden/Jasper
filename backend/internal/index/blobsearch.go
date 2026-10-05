package index

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// BlobHit is one attachment matched by name.
type BlobHit struct {
	ID        string
	Path      string
	MtimeUnix int64
}

// SearchBlobNames returns up to limit live attachment paths whose file name
// contains q, case-insensitively, newest first. An empty q lists the newest.
func (x *Indexer) SearchBlobNames(ctx context.Context, q string, limit int) ([]BlobHit, error) {
	if limit < 1 {
		limit = 1
	}
	if limit > 50 {
		limit = 50
	}
	pattern := "%" + escapeLike(strings.ToLower(strings.TrimSpace(q))) + "%"
	rows, err := x.Pair.Reader.QueryContext(ctx,
		`SELECT blob_id, path, mtime_unix FROM blob_paths
		 WHERE LOWER(replace(path, rtrim(path, replace(path, '/', '')), '')) LIKE ? ESCAPE '\'
		 ORDER BY mtime_unix DESC, path ASC LIMIT ?`, pattern, limit)
	if err != nil {
		return nil, fmt.Errorf("search blob names: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []BlobHit{}
	for rows.Next() {
		var h BlobHit
		if err := rows.Scan(&h.ID, &h.Path, &h.MtimeUnix); err != nil {
			return nil, fmt.Errorf("search blob names scan: %w", err)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// AdoptAttachment indexes a file that was just written under notes/, so an
// upload can be referred to by id before the next reconcile. relPath is the
// canonical vault-relative path.
func (x *Indexer) AdoptAttachment(ctx context.Context, relPath string) (string, error) {
	abs := filepath.Join(x.NotesDir, filepath.FromSlash(relPath))
	digest, size, err := hashFile(abs)
	if err != nil {
		return "", fmt.Errorf("adopt attachment %s: %w", relPath, err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("adopt attachment %s: %w", relPath, err)
	}
	existing, err := x.existingBlobPaths(ctx)
	if err != nil {
		return "", err
	}
	var prior *blobPathRow
	if row, ok := existing[relPath]; ok {
		prior = &row
	}
	return x.adoptBlob(ctx, relPath, digest, sniffMime(abs), size, info.ModTime().Unix(), prior)
}
