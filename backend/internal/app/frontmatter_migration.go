package app

// frontmatter_migration.go — Plan 06-06 Task 1.
//
// InjectFrontmatterScaffoldMigration is the D-11 one-time startup step that
// walks every .md file under notesDir and atomically prepends the
// frontmatter scaffold (`---\ntags: []\n---\n\n# {Title}\n\n`) to any file
// lacking a frontmatter block.
//
// Idempotency + resumability contract (D-11, D-39):
//  1. If schema_migrations already contains the marker row, return
//     immediately (no walk).
//  2. Per-file: markdown.HasFrontmatter short-circuits files that are
//     already migrated; a partial previous run resumes seamlessly.
//  3. The marker row is inserted ONLY after the entire walk completes
//     without error. A mid-walk crash leaves the marker absent so the
//     next start retries the remaining files.
//
// Lifecycle placement (DESIGN.md §6.1 listener gating):
//
//	AFTER the SQL migration runner (so schema_migrations exists)
//	BEFORE Indexer.Reconcile (so every .md file has frontmatter when the
//	indexer first parses it).

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/markdown"
)

// atomicWriteHook is a package-level test injection point that replaces
// the real fsstore.AtomicWrite call inside doAtomicWrite. Set only in
// tests (via setAtomicWriteHook in frontmatter_migration_test.go) to
// simulate mid-walk failures for the D-39 resumability test. nil means
// use the real fsstore.AtomicWrite.
//
//nolint:gochecknoglobals // test-hook pattern; intentionally mutable.
var (
	atomicWriteHook   func(path string, data []byte) error
	atomicWriteHookMu sync.Mutex
)

// FrontmatterScaffoldMarker is the version string inserted into
// schema_migrations after the one-time D-11 walk completes. The leading
// "006_" keeps lexical ordering consistent with the real migration filenames
// (e.g. "002_tags_backlinks.sql") without conflicting with them — marker
// strings lack a file extension.
const FrontmatterScaffoldMarker = "006_frontmatter_scaffold_complete"

// doAtomicWrite calls fsstore.AtomicWrite by default. In tests, the
// package-level atomicWriteHook variable can be set to simulate mid-walk
// failures for the D-39 resumability test.
func doAtomicWrite(path string, data []byte) error {
	atomicWriteHookMu.Lock()
	hook := atomicWriteHook
	atomicWriteHookMu.Unlock()

	if hook != nil {
		// Hook is set — use it (test-only path).
		return hook(path, data)
	}
	return fsstore.AtomicWrite(path, data)
}

// InjectFrontmatterScaffoldMigration implements the D-11 / TAGS-EXT-03
// startup step: walk notesDir and, for each .md file lacking a frontmatter
// block, atomically prepend the scaffold. On completion, record the
// FrontmatterScaffoldMarker in schema_migrations so the walk never runs
// again.
//
// Parameters:
//   - ctx      — passed to all DB calls; honour cancellation.
//   - writerDB — the single-writer *sql.DB (DATA-03); marker is written here.
//   - notesDir — absolute path to the vault's notes/ directory.
//   - log      — structured logger; one entry per injected file + summary.
func InjectFrontmatterScaffoldMigration(
	ctx context.Context,
	writerDB *sql.DB,
	notesDir string,
	log *slog.Logger,
) error {
	// 1. Check marker — if present, the migration is already complete.
	var dummy string
	err := writerDB.QueryRowContext(ctx,
		`SELECT version FROM schema_migrations WHERE version = ?`,
		FrontmatterScaffoldMarker,
	).Scan(&dummy)
	if err == nil {
		log.Info("frontmatter scaffold migration already complete; skipping")
		return nil
	}
	if err != sql.ErrNoRows {
		return fmt.Errorf("frontmatter migration: check marker: %w", err)
	}

	// 2. Walk the vault.
	log.Info("frontmatter scaffold migration: starting walk", "dir", notesDir)
	injected, skipped := 0, 0

	walkErr := filepath.WalkDir(notesDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		if d.IsDir() {
			// Skip dot-directories (.trash, .git, etc.) except the root itself.
			if strings.HasPrefix(d.Name(), ".") && path != notesDir {
				return filepath.SkipDir
			}
			return nil
		}

		// Skip non-.md files.
		if !strings.HasSuffix(strings.ToLower(d.Name()), ".md") {
			return nil
		}
		// Skip dot-files (.hidden.md).
		if strings.HasPrefix(d.Name(), ".") {
			return nil
		}

		// Read file content.
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			log.Warn("frontmatter migration: read failed; skipping file",
				"path", path, "err", readErr)
			skipped++
			return nil
		}

		// Skip files that already have frontmatter (per-file idempotency).
		if markdown.HasFrontmatter(content) {
			skipped++
			return nil
		}

		// Derive title from filename (strip .md extension).
		title := strings.TrimSuffix(d.Name(), filepath.Ext(d.Name()))

		// Build injected content. markdown.InjectFrontmatterScaffold is
		// idempotent — it short-circuits if content already has frontmatter,
		// so this call is safe even if HasFrontmatter was wrong (regression
		// guard from Plan 06-03 Test 10).
		newContent := markdown.InjectFrontmatterScaffold(content, title)

		if err := doAtomicWrite(path, newContent); err != nil {
			return fmt.Errorf("frontmatter migration: atomic write %s: %w", path, err)
		}

		injected++
		log.Info("frontmatter migration: injected",
			"path", path, "title", title)
		return nil
	})
	if walkErr != nil {
		return walkErr
	}

	// 3. Record marker after the full walk succeeds.
	if _, err := writerDB.ExecContext(ctx,
		`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
		FrontmatterScaffoldMarker, time.Now().Unix(),
	); err != nil {
		return fmt.Errorf("frontmatter migration: record marker: %w", err)
	}

	log.Info("frontmatter scaffold migration: complete",
		"injected_count", injected,
		"skipped_count", skipped)
	return nil
}
