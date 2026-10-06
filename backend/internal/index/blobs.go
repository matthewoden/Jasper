package index

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Blob is a distinct sequence of attachment bytes, identified by content.
type Blob struct {
	ID        string
	SHA256    string
	Mime      string
	Size      int64
	UpdatedAt int64
	Paths     []string // live paths holding these bytes, sorted
}

type blobPathRow struct {
	blobID string
	mtime  int64
	size   int64
}

// WalkAttachments calls yield for every file under notesDir that the tree
// lists as a file: not markdown, not a dotfile, not inside a dot directory
// (which excludes .trash/).
func WalkAttachments(ctx context.Context, notesDir string, yield func(FileMeta) error) error {
	return filepath.WalkDir(notesDir, func(path string, d fs.DirEntry, err error) error {
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		if err != nil {
			if path == notesDir {
				return fmt.Errorf("walk %q: %w", notesDir, err)
			}
			return nil
		}
		if d.IsDir() {
			if path != notesDir && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") || strings.HasSuffix(strings.ToLower(name), ".md") {
			return nil
		}
		rel, err := filepath.Rel(notesDir, path)
		if err != nil {
			return nil
		}
		canonical, err := fsstore.ContainedPath(notesDir, rel)
		if err != nil {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		canonRel, err := filepath.Rel(notesDir, canonical)
		if err != nil {
			return nil
		}
		return yield(FileMeta{
			CanonicalRelPath: filepath.ToSlash(canonRel),
			AbsPath:          canonical,
			Size:             info.Size(),
			MTimeUnix:        info.ModTime().Unix(),
		})
	})
}

// reconcileBlobs brings blobs and blob_paths in line with the attachments on
// disk. A path whose (mtime, size) pair is unchanged is not re-read, so the
// steady-state cost is a stat per file.
func (x *Indexer) reconcileBlobs(ctx context.Context, mode Mode) error {
	existing, err := x.existingBlobPaths(ctx)
	if err != nil {
		return fmt.Errorf("reconcile blobs: load existing: %w", err)
	}
	seen := make(map[string]bool, len(existing))

	walkErr := WalkAttachments(ctx, x.NotesDir, func(fm FileMeta) error {
		seen[fm.CanonicalRelPath] = true
		prior, ok := existing[fm.CanonicalRelPath]
		if mode == ModeIncremental && ok && prior.mtime == fm.MTimeUnix && prior.size == fm.Size {
			return nil
		}

		digest, size, err := hashFile(fm.AbsPath)
		if err != nil {
			x.Log.Warn("indexer: attachment read failed; skipping", "path", fm.CanonicalRelPath, "err", err)
			return nil
		}
		var replaced *blobPathRow
		if ok {
			replaced = &prior
		}
		if _, err := x.adoptBlob(ctx, fm.CanonicalRelPath, digest, sniffMime(fm.AbsPath), size, fm.MTimeUnix, replaced); err != nil {
			return fmt.Errorf("adopt %s: %w", fm.CanonicalRelPath, err)
		}
		return nil
	})
	if walkErr != nil {
		return fmt.Errorf("reconcile blobs: walk: %w", walkErr)
	}

	for path := range existing {
		if seen[path] {
			continue
		}
		if err := x.retireBlobPath(ctx, path); err != nil {
			return fmt.Errorf("reconcile blobs: retire %s: %w", path, err)
		}
	}
	return nil
}

func (x *Indexer) existingBlobPaths(ctx context.Context) (map[string]blobPathRow, error) {
	rows, err := x.Pair.Reader.QueryContext(ctx, `SELECT path, blob_id, mtime_unix, size_bytes FROM blob_paths`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]blobPathRow{}
	for rows.Next() {
		var path string
		var r blobPathRow
		if err := rows.Scan(&path, &r.blobID, &r.mtime, &r.size); err != nil {
			return nil, err
		}
		out[path] = r
	}
	return out, rows.Err()
}

func hashFile(absPath string) (string, int64, error) {
	f, err := os.Open(absPath)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func sniffMime(absPath string) string {
	if t := mime.TypeByExtension(filepath.Ext(absPath)); t != "" {
		return t
	}
	f, err := os.Open(absPath)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	return http.DetectContentType(head[:n])
}

func shortBlobID(digest string) string { return notes.BlobIDPrefix + digest[:16] }
func fullBlobID(digest string) string  { return notes.BlobIDPrefix + digest }

// adoptBlob records that path now holds the bytes with the given digest. The
// id is the digest's 16-hex prefix unless another digest already owns that
// prefix, in which case both move to their full digests. A path that held a
// different blob before is an in-place edit: the old blob is tombstoned,
// pointing at the new one, once no other path holds it.
func (x *Indexer) adoptBlob(ctx context.Context, path, digest, mimeType string, size, mtime int64, replaced *blobPathRow) (string, error) {
	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return "", fmt.Errorf("adopt begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	id := shortBlobID(digest)
	var ownerDigest string
	switch err := tx.QueryRowContext(ctx, `SELECT sha256 FROM blobs WHERE id = ?`, id).Scan(&ownerDigest); {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return "", fmt.Errorf("adopt prefix check: %w", err)
	case ownerDigest != digest:
		x.Log.Warn("indexer: blob id prefix collision; using full digests", "path", path, "id", id)
		if err := rekeyBlob(ctx, tx, id, fullBlobID(ownerDigest)); err != nil {
			return "", err
		}
		id = fullBlobID(digest)
	}

	now := x.nowUnix()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO blobs(id, sha256, mime, size, updated_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET mime = excluded.mime, updated_at = excluded.updated_at`,
		id, digest, mimeType, size, now); err != nil {
		return "", fmt.Errorf("adopt blob: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO blob_paths(path, blob_id, mtime_unix, size_bytes) VALUES (?, ?, ?, ?)
		 ON CONFLICT(path) DO UPDATE SET blob_id = excluded.blob_id, mtime_unix = excluded.mtime_unix, size_bytes = excluded.size_bytes`,
		path, id, mtime, size); err != nil {
		return "", fmt.Errorf("adopt path: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM tombstones WHERE id = ?`, id); err != nil {
		return "", fmt.Errorf("adopt clear tombstone: %w", err)
	}

	if replaced != nil && replaced.blobID != id {
		if err := x.retireBlobIfOrphaned(ctx, tx, replaced.blobID, path, id); err != nil {
			return "", err
		}
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("adopt commit: %w", err)
	}
	return id, nil
}

func rekeyBlob(ctx context.Context, tx *sql.Tx, oldID, newID string) error {
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO blobs(id, sha256, mime, size, updated_at)
		 SELECT ?, sha256, mime, size, updated_at FROM blobs WHERE id = ?`, newID, oldID); err != nil {
		return fmt.Errorf("rekey blob: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE blob_paths SET blob_id = ? WHERE blob_id = ?`, newID, oldID); err != nil {
		return fmt.Errorf("rekey paths: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM blobs WHERE id = ?`, oldID); err != nil {
		return fmt.Errorf("rekey drop old: %w", err)
	}
	return nil
}

// retireBlobPath forgets path. The blob it held is tombstoned when that was
// its last path. The blob is read inside the transaction: a re-key earlier in
// the same pass may have moved the path off the id the caller saw.
func (x *Indexer) retireBlobPath(ctx context.Context, path string) error {
	tx, err := x.Pair.BeginImmediate(ctx)
	if err != nil {
		return fmt.Errorf("retire begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var blobID string
	switch err := tx.QueryRowContext(ctx, `SELECT blob_id FROM blob_paths WHERE path = ?`, path).Scan(&blobID); {
	case errors.Is(err, sql.ErrNoRows):
		return nil
	case err != nil:
		return fmt.Errorf("retire lookup: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM blob_paths WHERE path = ?`, path); err != nil {
		return fmt.Errorf("retire path: %w", err)
	}
	if err := x.retireBlobIfOrphaned(ctx, tx, blobID, path, ""); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("retire commit: %w", err)
	}
	return nil
}

func (x *Indexer) retireBlobIfOrphaned(ctx context.Context, tx *sql.Tx, blobID, lastPath, replacedBy string) error {
	var live int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM blob_paths WHERE blob_id = ?`, blobID).Scan(&live); err != nil {
		return fmt.Errorf("retire count: %w", err)
	}
	if live > 0 {
		return nil
	}
	var replaced any
	if replacedBy != "" {
		replaced = replacedBy
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT OR REPLACE INTO tombstones(id, last_path, last_title, deleted_at, replaced_by) VALUES (?, ?, ?, ?, ?)`,
		blobID, lastPath, filepath.Base(lastPath), x.nowUnix(), replaced); err != nil {
		return fmt.Errorf("retire tombstone: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM blobs WHERE id = ?`, blobID); err != nil {
		return fmt.Errorf("retire blob: %w", err)
	}
	return nil
}

// GetBlob returns the blob with id and the live paths holding it.
func (x *Indexer) GetBlob(ctx context.Context, id string) (Blob, bool, error) {
	var b Blob
	err := x.Pair.Reader.QueryRowContext(ctx,
		`SELECT id, sha256, mime, size, updated_at FROM blobs WHERE id = ?`, id).
		Scan(&b.ID, &b.SHA256, &b.Mime, &b.Size, &b.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Blob{}, false, nil
	}
	if err != nil {
		return Blob{}, false, fmt.Errorf("blob %s: %w", id, err)
	}
	rows, err := x.Pair.Reader.QueryContext(ctx, `SELECT path FROM blob_paths WHERE blob_id = ? ORDER BY path`, id)
	if err != nil {
		return Blob{}, false, fmt.Errorf("blob %s paths: %w", id, err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return Blob{}, false, err
		}
		b.Paths = append(b.Paths, p)
	}
	return b, true, rows.Err()
}

// BlobAtPath returns the blob a path currently holds.
func (x *Indexer) BlobAtPath(ctx context.Context, path string) (Blob, bool, error) {
	var id string
	err := x.Pair.Reader.QueryRowContext(ctx, `SELECT blob_id FROM blob_paths WHERE path = ?`, path).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return Blob{}, false, nil
	}
	if err != nil {
		return Blob{}, false, fmt.Errorf("blob at %s: %w", path, err)
	}
	return x.GetBlob(ctx, id)
}
