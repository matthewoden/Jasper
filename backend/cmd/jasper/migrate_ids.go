package main

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/matthewoden/jasper/backend/internal/app"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

var migrateIDsDryRun bool

var migrateIDsCmd = &cobra.Command{
	Use:   "migrate-ids",
	Short: "Write an id into every note that lacks one",
	Long: `Walk the vault's notes/ directory and insert an "id:" line into the
frontmatter of every note that does not carry a valid one. Nothing else in
the file changes. The same walk runs automatically the first time the server
starts after an upgrade; this command performs it offline.

Use --dry-run to list the notes that would change without writing anything.

Stop the server first, or it sees a bulk change on its next refresh.`,
	RunE: runMigrateIDs,
}

func init() {
	migrateIDsCmd.Flags().BoolVar(&migrateIDsDryRun, "dry-run", false, "list the notes that would change; write nothing")
	rootCmd.AddCommand(migrateIDsCmd)
}

func runMigrateIDs(cmd *cobra.Command, _ []string) error {
	res := vault.ResolveForCLI(vaultFlag)
	notesDir := filepath.Join(res.DataDir, "notes")
	log := slog.New(slog.NewTextHandler(cmd.ErrOrStderr(), nil))

	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	report, err := app.InjectNoteIDs(ctx, notesDir, migrateIDsDryRun, log)
	if err != nil {
		return err
	}

	out := cmd.OutOrStdout()
	verb := "wrote"
	if migrateIDsDryRun {
		verb = "would write"
	}
	for _, p := range report.Written {
		if _, err := fmt.Fprintf(out, "%s id: %s\n", verb, p); err != nil {
			return err
		}
	}
	for id, paths := range report.Duplicates {
		if _, err := fmt.Fprintf(out, "duplicate id %s: %v\n", id, paths); err != nil {
			return err
		}
	}
	_, err = fmt.Fprintf(out, "%d notes scanned, %d %s an id\n",
		report.Scanned, len(report.Written), verb)
	return err
}
