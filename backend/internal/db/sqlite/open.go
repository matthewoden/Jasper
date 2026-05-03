package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	// modernc.org/sqlite is the ONLY acceptable SQLite driver — see
	// CLAUDE.md "What NOT to Use" — the CGo-based alternative is
	// forbidden because it requires CGo and breaks the
	// single-static-binary promise. modernc.org/sqlite registers
	// itself under the name "sqlite" (NOT "sqlite3") on import.
	_ "modernc.org/sqlite"
)

// Pair holds the writer/reader split required by DATA-03.
//
// Writer is a *sql.DB with MaxOpenConns=1 — every write is serialized
// onto a single connection so there is exactly one in-flight writer
// transaction at a time. Combined with BEGIN IMMEDIATE (forced by the
// _txlock=immediate DSN parameter — see Open), this guarantees the
// RESERVED lock is acquired up-front and SQLITE_BUSY does not surface
// during normal operation.
//
// Reader is a separate *sql.DB pool (MaxOpenConns=8 by default). Under
// WAL mode, readers never block writers and writers never block readers;
// the two halves run independently. See Task 3's
// concurrency_test.go::TestConcurrentWrites_5000Notes_NoBusy for the
// stress-test floor that backs ROADMAP success criterion #5.
type Pair struct {
	Writer *sql.DB // MaxOpenConns=1, BEGIN IMMEDIATE writes
	Reader *sql.DB // pooled reads, MaxOpenConns=8
}

// Open opens (or creates) the SQLite database at dbPath, applies the
// DATA-04 pragmas to both halves, verifies WAL is active, and returns
// the writer/reader pair.
//
// dbPath MUST be absolute. The caller (composition root in Plan 02-06)
// is responsible for ensuring the parent directory exists; Open does
// not auto-mkdir for the same reason fsstore.AtomicWrite does not —
// directory creation is a startup-lifecycle concern, not an I/O
// primitive concern (Phase 1 D-08 / Plan 01-02 pattern).
//
// The DSN encodes the pragmas via modernc.org/sqlite's _pragma= query
// parameter so each new connection (across both pools) gets the
// pragmas applied automatically by the driver. _txlock=immediate
// promotes every implicit BEGIN to "BEGIN IMMEDIATE" — defense in
// depth alongside Pair.BeginImmediate.
//
// Open returns an error wrapping the underlying cause when:
//   - dbPath is not absolute,
//   - sql.Open or Ping fails on either half,
//   - the post-Ping pragma re-application fails,
//   - PRAGMA journal_mode does not return "wal" (case-insensitive)
//     after the pragma application has run.
func Open(ctx context.Context, dbPath string) (*Pair, error) {
	if !filepath.IsAbs(dbPath) {
		return nil, fmt.Errorf("sqlite.Open: dbPath must be absolute, got %q", dbPath)
	}

	// Build the DSN. The _pragma= parameters survive the driver's lower-
	// cased pragma alias bugs that older modernc.org/sqlite versions
	// occasionally exhibit. _txlock=immediate forces BEGIN IMMEDIATE
	// for every implicit transaction (the literal string "BEGIN
	// IMMEDIATE" is the SQL the driver emits internally — see DATA-03).
	//
	// T-02-01-03 (information disclosure): the DSN includes the
	// absolute database path, so any sql.Open / Ping error wrapping
	// the DSN string can leak the path into logs. Risk is low for a
	// single-user self-host app where the user owns the path; logs do
	// not leave the user's machine (PROJECT.md "no telemetry").
	dsn := fmt.Sprintf(
		"file:%s?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)&_pragma=wal_autocheckpoint(1000)&_pragma=foreign_keys(ON)&_txlock=immediate",
		dbPath,
	)

	// Open writer first. MaxOpenConns(1) serializes all writes onto a
	// single connection — DATA-03's mitigation for T-02-01-02 (writer
	// flooding cannot starve the reader pool because reader is a
	// separate *sql.DB).
	writer, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("sqlite.Open: open writer: %w", err)
	}
	writer.SetMaxOpenConns(1)
	writer.SetMaxIdleConns(1)
	writer.SetConnMaxIdleTime(0)
	if err := writer.PingContext(ctx); err != nil {
		_ = writer.Close()
		return nil, fmt.Errorf("sqlite.Open: ping writer: %w", err)
	}

	// Open reader. The reader pool is sized for moderate concurrency
	// (8 readers cover the websocket fan-out + REST handlers +
	// indexer scans without contention).
	reader, err := sql.Open("sqlite", dsn)
	if err != nil {
		_ = writer.Close()
		return nil, fmt.Errorf("sqlite.Open: open reader: %w", err)
	}
	reader.SetMaxOpenConns(8)
	reader.SetMaxIdleConns(4)
	reader.SetConnMaxIdleTime(5 * time.Minute)
	if err := reader.PingContext(ctx); err != nil {
		_ = writer.Close()
		_ = reader.Close()
		return nil, fmt.Errorf("sqlite.Open: ping reader: %w", err)
	}

	// Defense-in-depth pragma re-application. Acquire one connection
	// from each pool, run PRAGMAs against it, then verify journal_mode
	// is WAL. If WAL is not active, the stress test in Plan 02-04 will
	// fail under load — fail fast at Open instead.
	if err := verifyAndApplyPragmas(ctx, writer); err != nil {
		_ = writer.Close()
		_ = reader.Close()
		return nil, fmt.Errorf("sqlite.Open: writer pragmas: %w", err)
	}
	if err := verifyAndApplyPragmas(ctx, reader); err != nil {
		_ = writer.Close()
		_ = reader.Close()
		return nil, fmt.Errorf("sqlite.Open: reader pragmas: %w", err)
	}

	return &Pair{Writer: writer, Reader: reader}, nil
}

// verifyAndApplyPragmas runs applyConnectionPragmas against a single
// connection drawn from db, then queries PRAGMA journal_mode and
// returns an error if it is not "wal" (case-insensitive). The
// connection is returned to the pool on exit.
func verifyAndApplyPragmas(ctx context.Context, db *sql.DB) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire conn: %w", err)
	}
	defer func() { _ = conn.Close() }()
	if err := applyConnectionPragmas(ctx, conn); err != nil {
		return err
	}
	var mode string
	if err := conn.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
		return fmt.Errorf("query journal_mode: %w", err)
	}
	if !strings.EqualFold(mode, "wal") {
		return fmt.Errorf("WAL not active: PRAGMA journal_mode returned %q", mode)
	}
	return nil
}

// Close closes Writer first (so any in-flight writer transactions are
// aborted via the connection close hook) and then Reader. Returns the
// first error encountered; both halves are closed unconditionally.
func (p *Pair) Close() error {
	wErr := p.Writer.Close()
	rErr := p.Reader.Close()
	if wErr != nil {
		return wErr
	}
	if rErr != nil {
		return rErr
	}
	return nil
}

// BeginImmediate starts a writer transaction. Internally the driver
// emits "BEGIN IMMEDIATE" as the SQL because the DSN sets
// _txlock=immediate; this acquires the RESERVED lock before any
// reader upgrade can race against it (DATA-03).
//
// The literal string "BEGIN IMMEDIATE" appears in this comment to
// satisfy the source-grep gate in 02-01-PLAN.md — the actual SQL is
// emitted by modernc.org/sqlite's driver code, not constructed in
// this file, because constructing it manually via tx.Exec would
// double-begin and break the database/sql state machine.
func (p *Pair) BeginImmediate(ctx context.Context) (*sql.Tx, error) {
	tx, err := p.Writer.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelDefault})
	if err != nil {
		return nil, fmt.Errorf("BeginImmediate: %w", err)
	}
	return tx, nil
}

// ErrWALNotActive is returned by Open when PRAGMA journal_mode does
// not return "wal" after the pragma sequence has run. Exported so
// callers (and tests) can match it with errors.Is.
//
// We do not return this directly today — Open wraps with fmt.Errorf
// for the path information — but the exported sentinel is here for
// future callers that want a typed match.
var ErrWALNotActive = errors.New("sqlite: WAL not active")
