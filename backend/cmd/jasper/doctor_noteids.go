package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"sort"
	"strings"

	"github.com/matthewoden/jasper/backend/internal/app"
)

// checkNoteIDs reports notes that have no durable id: ones missing an id line,
// ones whose CRLF frontmatter the writer refuses to touch, and ids claimed by
// more than one note.
func checkNoteIDs(dataDir string) DoctorCheck {
	const name = "note ids"
	notesDir := filepath.Join(dataDir, "notes")
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	report, err := app.InjectNoteIDs(context.Background(), notesDir, true, quiet)
	if err != nil {
		return DoctorCheck{Name: name, Status: "fail", Hint: fmt.Sprintf("could not scan notes/: %v", err)}
	}

	var problems []string
	if n := len(report.Written); n > 0 {
		problems = append(problems, fmt.Sprintf("%d missing an id (run 'jasper migrate-ids', or start the server)", n))
	}
	if n := len(report.CRLF); n > 0 {
		problems = append(problems, fmt.Sprintf("%d with CRLF frontmatter (convert to LF): %s", n, strings.Join(report.CRLF, ", ")))
	}
	if n := len(report.Duplicates); n > 0 {
		ids := make([]string, 0, n)
		for id := range report.Duplicates {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		var parts []string
		for _, id := range ids {
			parts = append(parts, id+" in "+strings.Join(report.Duplicates[id], ", "))
		}
		problems = append(problems, fmt.Sprintf("%d id(s) shared by several notes (the server keeps the first and re-ids the rest): %s", n, strings.Join(parts, "; ")))
	}
	if len(problems) == 0 {
		return DoctorCheck{Name: name, Status: "ok"}
	}
	return DoctorCheck{Name: name, Status: "fail", Hint: strings.Join(problems, "; ")}
}
