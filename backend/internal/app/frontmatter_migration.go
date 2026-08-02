package app

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
// tests to simulate mid-walk failures. nil means use the real
// fsstore.AtomicWrite.
//
//nolint:gochecknoglobals // test-hook pattern; intentionally mutable.
var (
	atomicWriteHook   func(path string, data []byte) error
	atomicWriteHookMu sync.Mutex
)

// FrontmatterScaffoldMarker is the version string inserted into
// schema_migrations after the one-time walk completes. The leading "006_"
// keeps lexical ordering consistent with real migration filenames (e.g.
// "002_tags_backlinks.sql") without conflicting with them — marker strings
// lack a file extension.
const FrontmatterScaffoldMarker = "006_frontmatter_scaffold_complete"

func doAtomicWrite(path string, data []byte) error {
	atomicWriteHookMu.Lock()
	hook := atomicWriteHook
	atomicWriteHookMu.Unlock()

	if hook != nil {
		return hook(path, data)
	}
	return fsstore.AtomicWrite(path, data)
}

// InjectFrontmatterScaffoldMigration prepends the scaffold to every .md file
// lacking frontmatter, then records a marker in schema_migrations so the walk
// never runs again.
func InjectFrontmatterScaffoldMigration(
	ctx context.Context,
	writerDB *sql.DB,
	notesDir string,
	log *slog.Logger,
) error {
	var dummy string
	err := writerDB.QueryRowContext(
		ctx,
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

	log.Info("frontmatter scaffold migration: starting walk", "dir", notesDir)
	injected, skipped := 0, 0

	walkErr := filepath.WalkDir(notesDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		if d.IsDir() {
			if strings.HasPrefix(d.Name(), ".") && path != notesDir {
				return filepath.SkipDir
			}
			return nil
		}

		if !strings.HasSuffix(strings.ToLower(d.Name()), ".md") {
			return nil
		}

		if strings.HasPrefix(d.Name(), ".") {
			return nil
		}

		content, readErr := os.ReadFile(path)
		if readErr != nil {
			log.Warn("frontmatter migration: read failed; skipping file",
				"path", path, "err", readErr)
			skipped++
			return nil
		}

		if markdown.HasFrontmatter(content) {
			skipped++
			return nil
		}

		title := strings.TrimSuffix(d.Name(), filepath.Ext(d.Name()))

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

	if _, err := writerDB.ExecContext(
		ctx,
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
