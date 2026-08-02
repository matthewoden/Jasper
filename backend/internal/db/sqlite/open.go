package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	// modernc.org/sqlite is the ONLY acceptable SQLite driver — the
	// CGo-based alternative requires CGo and breaks the
	// single-static-binary promise. modernc.org/sqlite registers
	// itself under the name "sqlite" (NOT "sqlite3") on import.
	_ "modernc.org/sqlite"
)

// Pair holds the writer/reader split (ADR-0025). Writer is MaxOpenConns=1, so
// exactly one writer transaction is ever in flight; with BEGIN IMMEDIATE the
// RESERVED lock is taken up front and SQLITE_BUSY never surfaces. Reader is a
// separate pool — under WAL the two halves never block each other.
type Pair struct {
	Writer *sql.DB // MaxOpenConns=1, BEGIN IMMEDIATE writes
	Reader *sql.DB // pooled reads, MaxOpenConns=8
}

// Open opens (or creates) the database at dbPath and returns the writer/reader
// pair, erroring unless WAL is actually active afterwards.
//
// dbPath MUST be absolute, and Open does NOT auto-mkdir — directory creation is
// a startup-lifecycle concern, not an I/O primitive's.
//
// _txlock=immediate promotes every implicit BEGIN, defence in depth alongside
// Pair.BeginImmediate.
func Open(ctx context.Context, dbPath string) (*Pair, error) {
	if !filepath.IsAbs(dbPath) {
		return nil, fmt.Errorf("sqlite.Open: dbPath must be absolute, got %q", dbPath)
	}

	dsn := fmt.Sprintf(
		"file:%s?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)&_pragma=wal_autocheckpoint(1000)&_pragma=foreign_keys(ON)&_txlock=immediate",
		dbPath,
	)

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
// reader upgrade can race against it. The actual SQL is emitted by
// modernc.org/sqlite's driver code — constructing it manually via
// tx.Exec would double-begin and break the database/sql state machine.
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
