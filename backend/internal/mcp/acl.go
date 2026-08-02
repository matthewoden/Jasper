// Package mcp provides the MCP server and its folder-scoped write ACL.
//
// Reads are global; writes resolve the most-specific ancestor grant.
// Tier 1 is create+update, Tier 2 adds move+delete.
//
// Grants are recursive and there are no deny entries — to exclude a subfolder,
// grant its siblings instead.
//
// Revocation takes effect on the next tool call; in-flight writes finish.
package mcp

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

// GrantLevel mirrors the integer level column in mcp_write_grants.
// Two values are legal per the CHECK constraint; Set rejects anything else.
type GrantLevel int

const (
	// TierEditOnly is Tier 1: create_note + update_note.
	TierEditOnly GrantLevel = 1
	// TierFull is Tier 2: create_note + update_note + move_note + delete_note.
	TierFull GrantLevel = 2
)

// Grant is the in-memory shape of a single row from mcp_write_grants.
// JSON tags match the openapi.yaml McpGrant schema so callers can
// re-serialize without a separate wire struct.
type Grant struct {
	FolderPath string     `json:"folder_path"`
	Level      GrantLevel `json:"level"`
	GrantedAt  time.Time  `json:"granted_at"`
	GrantedVia string     `json:"granted_via"`
}

// ACL is the folder-grant access-control layer. It is a thin wrapper
// over the writer *sql.DB — every method is goroutine-safe because
// database/sql handles concurrency. State lives entirely in SQLite;
// the grant table is recoverable by re-granting after a DB wipe.
type ACL struct {
	db *sql.DB
}

// NewACL returns an ACL backed by db. db must be the writer pool
// (MaxOpenConns=1) so the UPSERT path in Set serializes properly
// against any concurrent Revoke / List call.
func NewACL(db *sql.DB) *ACL { return &ACL{db: db} }

// List returns every grant ordered by folder_path ascending. Empty
// slice (not nil) on no rows — callers can json-encode the result
// directly without a nil check.
func (a *ACL) List(ctx context.Context) ([]Grant, error) {
	rows, err := a.db.QueryContext(ctx,
		`SELECT folder_path, level, granted_at, granted_via FROM mcp_write_grants ORDER BY folder_path ASC`)
	if err != nil {
		return nil, fmt.Errorf("list grants: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]Grant, 0)
	for rows.Next() {
		var g Grant
		var ts int64
		var lvl int
		if err := rows.Scan(&g.FolderPath, &lvl, &ts, &g.GrantedVia); err != nil {
			return nil, fmt.Errorf("scan grant row: %w", err)
		}
		g.Level = GrantLevel(lvl)
		g.GrantedAt = time.Unix(ts, 0).UTC()
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate grant rows: %w", err)
	}
	return out, nil
}

// Set upserts a grant, so re-granting at a different tier is an in-place
// change rather than a second row.
//
// Returns the resulting grant on success. Errors:
//   - invalid level (not TierEditOnly / TierFull)
//   - empty folder_path
//   - folder_path containing ".." (path-escape attempt)
//   - absolute folder_path (must be relative)
func (a *ACL) Set(ctx context.Context, folderPath string, level GrantLevel, via string) (Grant, error) {
	if level != TierEditOnly && level != TierFull {
		return Grant{}, errors.New("invalid level: must be 1 or 2")
	}

	if strings.Contains(folderPath, "..") {
		return Grant{}, errors.New(`folder_path must not contain ".." segments`)
	}
	norm := normalizeGrantPath(folderPath)
	if norm == "" || norm == "." {
		return Grant{}, errors.New("folder_path required")
	}

	if filepath.IsAbs(norm) {
		return Grant{}, errors.New("folder_path must be relative")
	}

	now := time.Now().Unix()
	_, err := a.db.ExecContext(ctx,
		`INSERT INTO mcp_write_grants (folder_path, level, granted_at, granted_via)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(folder_path) DO UPDATE
		   SET level = excluded.level,
		       granted_at = excluded.granted_at,
		       granted_via = excluded.granted_via`,
		norm, int(level), now, via)
	if err != nil {
		return Grant{}, fmt.Errorf("upsert grant: %w", err)
	}
	return Grant{
		FolderPath: norm,
		Level:      level,
		GrantedAt:  time.Unix(now, 0).UTC(),
		GrantedVia: via,
	}, nil
}

// Revoke deletes a grant by folder_path. Returns nil if the row didn't
// exist — revocation is idempotent so the frontend doesn't have to
// distinguish "already gone" from "never existed".
func (a *ACL) Revoke(ctx context.Context, folderPath string) error {
	norm := normalizeGrantPath(folderPath)
	if _, err := a.db.ExecContext(ctx,
		`DELETE FROM mcp_write_grants WHERE folder_path = ?`, norm); err != nil {
		return fmt.Errorf("delete grant: %w", err)
	}
	return nil
}

// Resolve returns the most-specific ancestor grant, or (0, false).
//
// It starts at filepath.Dir(notePath) because grants are folder-scoped. A
// caller asking "is THIS folder granted?" must append a "/x" sentinel, or the
// Dir strip walks one level too high. Tool dispatch always passes a note path.
func (a *ACL) Resolve(ctx context.Context, notePath string) (GrantLevel, bool) {
	cur := filepath.Dir(normalizeGrantPath(notePath))
	for {
		var lvl int
		err := a.db.QueryRowContext(ctx,
			`SELECT level FROM mcp_write_grants WHERE folder_path = ?`, cur).Scan(&lvl)
		if err == nil {
			return GrantLevel(lvl), true
		}
		if cur == "." || cur == "/" || cur == "" {
			return 0, false
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return 0, false
		}
		cur = parent
	}
}

// CanCreate returns true iff notePath has any grant (Tier 1 or Tier 2).
// Tier 1 covers create + update so both checks share Resolve.
func (a *ACL) CanCreate(ctx context.Context, notePath string) bool {
	_, ok := a.Resolve(ctx, notePath)
	return ok
}

// CanUpdate is identical to CanCreate — Tier 1 covers both.
func (a *ACL) CanUpdate(ctx context.Context, notePath string) bool {
	return a.CanCreate(ctx, notePath)
}

// CanMove returns true iff notePath has a Tier 2 grant on an ancestor.
// Tier 1 grants do NOT satisfy this check.
func (a *ACL) CanMove(ctx context.Context, notePath string) bool {
	lvl, ok := a.Resolve(ctx, notePath)
	return ok && lvl == TierFull
}

// CanDelete is identical to CanMove — both are Tier-2-only ops.
func (a *ACL) CanDelete(ctx context.Context, notePath string) bool {
	return a.CanMove(ctx, notePath)
}

func normalizeGrantPath(p string) string {
	p = strings.TrimSpace(p)
	p = strings.TrimPrefix(p, "/")
	p = strings.TrimSuffix(p, "/")
	p = filepath.ToSlash(filepath.Clean(p))
	return strings.ToLower(p)
}
