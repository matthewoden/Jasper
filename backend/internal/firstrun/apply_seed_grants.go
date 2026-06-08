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

// ApplySeedGrants reads <dataDir>/.jasper/seed_grants.json, applies any
// queued mcp_write_grants via INSERT ... ON CONFLICT DO UPDATE, and
// deletes the file on success. Idempotent: returns nil if the file does
// not exist (the common path on every boot of an established vault).
//
// Per Phase 9 D-04: firstrun.RunSetup queues grants at submit time (when
// the per-vault DB does not yet exist after Plan 03a's "CreateVault does
// not open the DB" refactor); the server's first boot of the vault drains
// the queue after migrations.
//
// Path discipline (mitigates T-09-03b-06): both writer (writeSeedGrants
// in submit.go) and reader (this function) compute the path via
// vault.SeedGrantsPath with their respective canonical roots. RunSetup
// canonicalizes once at the top and passes the canonical value to the
// writer. Lifecycle invokes this with a.cfg.DataDir, which is canonical
// post-boot. Same helper, same input → same path. No TOCTOU.
//
// Errors:
//   - JSON decode failure: returns wrapped error, leaves file in place
//     so the operator can inspect and correct it.
//   - SQL execution failure: returns wrapped error, leaves file in place.
//   - File-delete failure after a successful apply: returns nil (grants
//     are applied; a leftover queue file is cosmetic and the next boot
//     will re-apply them idempotently via ON CONFLICT DO UPDATE).
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

	// SQL preserved verbatim from the deleted firstrun.insertSeedGrants
	// (migration 004 schema: folder_path UNIQUE, level CHECK (1,2),
	// granted_at INTEGER UNIX seconds, granted_via TEXT). Bound
	// parameters mitigate T-09-03b-02 (SQL injection via folder_path).
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
