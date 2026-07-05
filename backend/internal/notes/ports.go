package notes

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/markdown"
)

// ErrFTSQuerySyntax is returned by SearchFTS when the user's query violates
// FTS5 MATCH syntax. Handlers map to HTTP 400 + code='invalid_query'.
var ErrFTSQuerySyntax = errors.New("fts query syntax error")

// SearchHit is one row of an FTS5 search result.
type SearchHit struct {
	ID           string
	Title        string
	Path         string
	ExcerptHTML  string // contains <mark>...</mark> from FTS5 snippet()
	MatchingTags []string
	Rank         float64 // bm25 + recency blend; lower is better
	ModifiedAt   time.Time
}

// FileStore is the port over the filesystem adapter (internal/fsstore).
// Defined here per the hexagonal-lite layout: notes/ owns the interface,
// fsstore/ implements it.
type FileStore interface {
	// Read returns the bytes at relPath under the configured data root.
	// Returns an error wrapping fs.ErrNotExist if the file does not exist.
	// Implementations canonicalize relPath internally (NFC + lowercase + escape checks).
	Read(relPath string) ([]byte, error)

	// WriteAtomic writes data to relPath durably. Implementations
	// canonicalize relPath internally and route through the atomic-write
	// primitive (temp + fsync(file) + rename + fsync(parent dir)).
	WriteAtomic(relPath string, data []byte) error

	// Stat returns the modification time of relPath, used by Service to
	// populate Note.UpdatedAt. Returns an error wrapping fs.ErrNotExist
	// if the file is missing.
	Stat(relPath string) (modTime time.Time, err error)

	// FS mutation primitives. Implementations route through fsstore.Canonicalize
	// internally for path canonicalization, collision detection, and atomic writes.
	// See backend/internal/fsstore/ops.go for the full contract:
	//
	//   - CreateFile creates a zero-byte .md file; ErrCaseCollision if
	//     the path is already taken; ErrParentNotFound if the immediate
	//     parent does not exist (single-level mkdir policy).
	//   - DeleteFile removes a file; fs.ErrNotExist propagates so the
	//     API layer maps to 404.
	//   - MoveFile renames a file; ErrCaseCollision / ErrParentNotFound
	//     for the destination; both paths are canonicalized.
	//   - CreateDir creates a directory with mode 0755; ErrCaseCollision
	//     if anything (file or dir) already exists at the path;
	//     ErrParentNotFound if the immediate parent does not exist.
	//   - DeleteDir(recursive=false) returns ErrFolderNotEmpty if the
	//     directory has any children; recursive=true removes the entire
	//     subtree.
	//   - MoveDir renames a directory; ErrCycle if the destination is
	//     the source itself or a descendant of it; ErrCaseCollision /
	//     ErrParentNotFound otherwise.
	//   - TrashFile moves a note into <dataDir>/.trash/, flattening
	//     the path (D-02); returns the collision-safe base name written;
	//     never overwrites (D-04); paths are canonicalized internally.
	//   - TrashDir moves a folder + subtree into <dataDir>/.trash/ intact
	//     (D-03); returns the collision-safe folder name written;
	//     paths are canonicalized internally.
	CreateFile(relPath string) error
	DeleteFile(relPath string) error
	MoveFile(oldRelPath, newRelPath string) error
	CreateDir(relPath string) error
	DeleteDir(relPath string, recursive bool) error
	MoveDir(oldRelPath, newRelPath string) error
	TrashFile(relPath string) (trashName string, err error)
	TrashDir(relPath string) (trashName string, err error)
}

// Broadcaster is the port over the WebSocket hub adapter (internal/wshub).
// Defined here per the hexagonal-lite layout: notes/ owns the interface,
// wshub/ implements it.
//
// Service mutations call Broadcast AFTER a successful Index.Upsert — NEVER
// before. originSessionID is sourced from the request context via
// SessionIDFromContext (chi middleware extracts X-Session-ID per request).
//
// SECURITY: Broadcast payloads MUST contain ONLY metadata (id, path,
// updated_at, title, etc.) — NEVER note content. This is a Service-layer
// contract; the broadcaster has no enforcement mechanism.
//
// The reconciler does NOT call Broadcast — only API mutation paths do.
// Per-file note:updated during a large reindex would fill per-client
// buffers and drop slow clients; reindex visibility is handled by the
// aggregated reindex:started / reindex:complete events instead.
//
// Passing nil for Broadcaster is allowed; Service substitutes nopBroadcaster.
type Broadcaster interface {
	Broadcast(eventType string, payload any, originSessionID string)
}

// Index is the port over the SQLite derived-index adapter. The
// concrete implementation lives in internal/index.
//
// The Index is a derived projection of the filesystem; wiping the database
// is never data loss because Reconcile rebuilds it from the .md files.
//
// Passing nil for Index is allowed; Service substitutes nopIndex{} so
// callers that don't wire the real indexer get no-op behavior.
type Index interface {
	// Upsert inserts or updates the index row for rec. Called from
	// Service.Update AFTER WriteAtomic succeeds (file-FIRST). On a
	// case-insensitive path conflict with an existing row whose ID
	// differs, returns ErrCaseCollision; the API layer maps this to 409.
	// Other errors are LOGGED by the caller and the file write is
	// preserved — the index is recoverable via Reconcile.
	Upsert(ctx context.Context, rec NoteRecord) error

	// Delete removes the index row for the given UUID. No-op if the row
	// is already absent (idempotent — file-deletes can race with the
	// indexer scan).
	Delete(ctx context.Context, id uuid.UUID) error

	// List returns one NoteSummary per indexed note for the file-tree /
	// notes-list UI. Order is undefined at the port level; the API
	// handler / UI is responsible for any sort.
	List(ctx context.Context) ([]NoteSummary, error)

	// LookupByPath finds a NoteRecord by its canonical relative path
	// (NFC + lowercase). Returns ErrNotFound when missing.
	// Used by Service.Move to look up the existing record before issuing
	// the rename.
	LookupByPath(ctx context.Context, canonicalPath string) (NoteRecord, error)

	// MovePathPrefix updates every notes row whose path starts with
	// oldPrefix to start with newPrefix instead. Used by Service.MoveFolder
	// to recursively re-canonicalize every note under a renamed folder
	// in one BEGIN IMMEDIATE transaction. Both prefixes MUST end with "/"
	// (or be empty for the vault root). Returns the count of updated rows.
	// Returns ErrCaseCollision if any row already lives under newPrefix
	// and that row's source is NOT itself under oldPrefix.
	MovePathPrefix(ctx context.Context, oldPrefix, newPrefix string) (int, error)

	// DeleteByPathPrefix removes every row whose path starts with prefix
	// (treated as a folder, with children matching prefix + "/..." plus
	// the bare prefix itself). The empty prefix means "all rows" — used
	// by drop-and-rebuild reindex. Returns the count of deleted rows.
	DeleteByPathPrefix(ctx context.Context, prefix string) (int, error)

	// ListTags returns all tags that have at least one carrier note, sorted
	// alphabetically by name. Returns a non-nil empty slice when no tags exist.
	ListTags(ctx context.Context) ([]TagWithCount, error)

	// SyncTags replaces all tags for noteID atomically (orphan cleanup).
	// Passing nil or empty slice removes all tags for the note.
	SyncTags(ctx context.Context, noteID uuid.UUID, tags []string) error

	// SyncBacklinks resolves [[Title]] refs, deduplicates, and rewrites
	// all backlinks rows for sourceID atomically.
	SyncBacklinks(ctx context.Context, sourceID uuid.UUID, sourcePath string,
		refs []markdown.WikiLinkRef, registry *Registry, content []byte) error

	// NotesByTag returns one NoteSummary per note carrying the named tag,
	// sorted by mtime descending. Returns a non-nil empty slice when no
	// notes carry the tag.
	NotesByTag(ctx context.Context, name string) ([]NoteSummary, error)

	// RenameTag atomically renames oldName to newName in the SQL store and
	// returns the UUIDs of all carrier notes. Returns ErrTagNotFound,
	// ErrTagCollision, ErrInvalidTagName on the respective error conditions.
	RenameTag(ctx context.Context, oldName, newName string) ([]uuid.UUID, error)

	// DeleteTag atomically removes the tag and its note_tags rows and returns
	// the UUIDs of the notes that carried it. Returns ErrTagNotFound.
	DeleteTag(ctx context.Context, name string) ([]uuid.UUID, error)

	// SourcesByBacklinkTitle returns one NoteSummary per source note that has
	// a backlinks row where target_title = title. Used by
	// RenameRewriteWikilinks to locate referrers without a full-vault FS scan.
	SourcesByBacklinkTitle(ctx context.Context, title string) ([]NoteSummary, error)

	// UpdateBacklinksTargetTitle bulk-updates every backlinks row with
	// target_title = oldTitle to use newTitle (and optionally newTargetID).
	// Called by RenameRewriteWikilinks after the FS pass succeeds. Non-fatal
	// on error — filesystem is truth; next Reconcile heals.
	UpdateBacklinksTargetTitle(ctx context.Context, oldTitle, newTitle string, newTargetID *uuid.UUID) error

	// GetBacklinks returns the resolved backlinks for targetID sorted by
	// source note recency (mtime_unix DESC). Pending rows are excluded.
	// Returns a non-nil empty slice when there are none.
	GetBacklinks(ctx context.Context, targetID uuid.UUID) ([]BacklinkRow, error)

	// SearchTitles returns up to limit notes whose titles contain q
	// (case-insensitive LIKE match), ordered by mtime DESC. When q is
	// empty, returns the most-recent notes up to limit. Max limit = 50.
	SearchTitles(ctx context.Context, q string, limit int) ([]SearchResult, error)

	// SearchFTS runs an FTS5 query against notes body+tag_names with
	// optional AND-combined tag filters. Sort = bm25 + recency blend
	// (weight 0.002). Returns up to `limit` results (capped at 100).
	// Returns ErrFTSQuerySyntax on FTS5 syntax errors so the handler
	// can map to HTTP 400.
	SearchFTS(ctx context.Context, q string, tags []string, limit int) ([]SearchHit, error)
}

// BacklinkRow is the projection returned by Index.GetBacklinks.
// Matches the BacklinkRow component schema in api/openapi.yaml.
//
// Excerpts carries one context-line excerpt per distinct `[[...]]` mention
// line in the source note (D-16); len(Excerpts) is the derived count of
// mention lines (multiple references on the same line collapse to one
// excerpt for that line).
type BacklinkRow struct {
	SourceID    uuid.UUID
	SourceTitle string
	SourcePath  string
	Excerpts    []string // server-built HTML snippets, one per mention line
}

// SearchResult is the projection returned by Index.SearchTitles.
// Used by GetNotesSearchTitles for wiki-link autocomplete.
type SearchResult struct {
	ID        uuid.UUID
	Title     string
	Path      string
	MtimeUnix int64
}

// TagWithCount is the projection returned by Index.ListTags.
// Matches the TagWithCount component schema in api/openapi.yaml.
type TagWithCount struct {
	Name  string
	Count int
}

// NoteRecord is the canonical projection of a .md file into the index.
// Both the indexer and Service.Update populate this struct; the SQLite
// store reads from it column-for-column.
//
// MTimeUnix is the file's last-modified time as observed by os.Stat at
// index time (the on-disk mtime). UpdatedAtUnix is the index-touch time
// — when the indexer last wrote this row — and is distinct from
// MTimeUnix because Reconcile can re-touch a row without the file changing.
//
// Checksum is reserved for a future checksum-fallback strategy; always “”.
//
// BodyFTS is the note body with the leading YAML frontmatter block stripped
// so frontmatter keys don't pollute body FTS matches.
// TagNamesFTS is the space-joined list of normalized tag names for the note
// (enabling tag-name FTS matches in addition to note_tags joins). Both are
// “” for callers without content available; the next reconcile pass repopulates.
type NoteRecord struct {
	ID            uuid.UUID
	Path          string // canonical relpath (NFC + lowercase) under notes/
	Title         string // first-H1 or filename-without-.md
	MTimeUnix     int64
	SizeBytes     int64
	Checksum      string // SHA-256 hex; always “” (reserved)
	UpdatedAtUnix int64  // index-touch time (NOT file mtime)
	BodyFTS       string
	TagNamesFTS   string
}

// NoteSummary is the projection returned by Index.List for the
// file-tree / notes-list UI. UpdatedAt is the file's mtime (NOT the
// index-touch time) so the UI shows file-relevant timestamps.
//
// The wire shape (api.Note in openapi.yaml) is a subset of this struct;
// the API handler translates NoteSummary -> api.Note, keeping internal-only
// fields (Checksum, UpdatedAtUnix) off the wire.
type NoteSummary struct {
	ID        uuid.UUID
	Path      string
	Title     string
	UpdatedAt time.Time
}
