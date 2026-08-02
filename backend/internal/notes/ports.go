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
	CreatedAt    time.Time // COALESCE(NULLIF(birthtime_unix,0), created_at)
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

	// FS mutation primitives. Implementations canonicalize internally; the
	// per-method contract and its sentinel errors live in fsstore/ops.go.
	CreateFile(relPath string) error
	DeleteFile(relPath string) error
	MoveFile(oldRelPath, newRelPath string) error
	CreateDir(relPath string) error
	DeleteDir(relPath string, recursive bool) error
	MoveDir(oldRelPath, newRelPath string) error
	TrashFile(relPath string) (trashName string, err error)
	TrashDir(relPath string) (trashName string, err error)
}

// Broadcaster is the port over the WebSocket hub. Broadcast fires AFTER a
// successful Index.Upsert, never before. Nil is allowed.
//
// SECURITY: payloads carry ONLY metadata, NEVER note content. Nothing enforces
// this — it is a Service-layer contract.
//
// The reconciler must NOT broadcast: per-file events during a large reindex
// would fill client buffers and drop slow clients. Use the aggregated
// reindex:started / reindex:complete events instead.
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
	// optional AND-combined tag filters. sort selects the ORDER BY:
	// "relevance" (default, bm25 + recency blend, weight 0.002),
	// "modified" (n.updated_at DESC), or "created"
	// (COALESCE(NULLIF(birthtime_unix,0), created_at) DESC). Returns up to
	// `limit` results (capped at 100). Returns ErrFTSQuerySyntax on FTS5
	// syntax errors so the handler can map to HTTP 400.
	SearchFTS(ctx context.Context, q string, tags []string, limit int, sort string) ([]SearchHit, error)
}

// BacklinkRow is the projection returned by Index.GetBacklinks.
// Matches the BacklinkRow component schema in api/openapi.yaml.
//
// Excerpts carries one context-line excerpt per distinct `[[...]]` mention
// line in the source note; len(Excerpts) is the derived count of
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
//
// Three timestamps that are easy to confuse: MTimeUnix is the on-disk mtime,
// UpdatedAtUnix is when the indexer last touched the row (Reconcile can bump it
// without the file changing), and BirthtimeUnix is the filesystem creation time
// — 0 when the platform cannot report one.
//
// BodyFTS/TagNamesFTS are "" for callers without content; reconcile repopulates.
// Checksum is always "".
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
	BirthtimeUnix int64
}

// NoteSummary is the projection returned by Index.List for the
// file-tree / notes-list UI. UpdatedAt is the file's mtime (NOT the
// index-touch time) so the UI shows file-relevant timestamps. CreatedAt
// is COALESCE(NULLIF(birthtime_unix,0), created_at), used by
// the tree projection (BuildTree) to expose a "created" sort data point.
//
// The wire shape (api.Note in openapi.yaml) is a subset of this struct;
// the API handler translates NoteSummary -> api.Note, keeping internal-only
// fields (Checksum, UpdatedAtUnix) off the wire.
type NoteSummary struct {
	ID        uuid.UUID
	Path      string
	Title     string
	UpdatedAt time.Time
	CreatedAt time.Time
}
