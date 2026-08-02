package firstrun

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"time"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

// ApplySeedGrants drains the grant queue RunSetup writes at submit time, when
// the per-vault DB does not yet exist. Idempotent — no file is the common path.
//
// Every failure leaves the file in place for the operator to inspect, except a
// failed delete after a successful apply: the next boot re-applies harmlessly.
func ApplySeedGrants(ctx context.Context, db *sql.DB, dataDir string) error {
	path := vault.SeedGrantsPath(dataDir)
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("ApplySeedGrants: read %s: %w", path, err)
	}

	var grants []SetupGrantSeed
	if err := json.Unmarshal(raw, &grants); err != nil {
		return fmt.Errorf("ApplySeedGrants: decode %s: %w", path, err)
	}

	// migration 004 schema: folder_path UNIQUE, level CHECK (1,2),
	// granted_at INTEGER UNIX seconds, granted_via TEXT. Bound
	// parameters prevent SQL injection via folder_path.
	const insertSQL = `INSERT INTO mcp_write_grants (folder_path, level, granted_at, granted_via)
		 VALUES (?, ?, ?, 'wizard')
		 ON CONFLICT(folder_path) DO UPDATE SET
		   level = excluded.level,
		   granted_at = excluded.granted_at,
		   granted_via = 'wizard'`

	now := time.Now().Unix()
	for _, g := range grants {
		if _, err := db.ExecContext(ctx, insertSQL, g.Folder, g.Level, now); err != nil {
			return fmt.Errorf("ApplySeedGrants: insert grant %q: %w", g.Folder, err)
		}
	}

	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		// Non-fatal: grants are applied; on the next boot the file will
		// be drained again — ON CONFLICT DO UPDATE makes this safe.
		return nil
	}
	return nil
}
