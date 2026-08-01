package notes

import (
	"testing"

	"github.com/google/uuid"
	"golang.org/x/text/unicode/norm"
)

func newTestRegistry() *Registry {
	return &Registry{
		byID:    make(map[uuid.UUID]string),
		byTitle: make(map[string][]NoteRecord),
	}
}

// TestRegistryFindByTitle_SingleMatch verifies that a single matching
// record is returned correctly.
func TestRegistryFindByTitle_SingleMatch(t *testing.T) {
	t.Parallel()
	r := newTestRegistry()
	id := uuid.New()
	r.AddRecord(id, "notes/Foo.md", "foo")

	got := r.FindByTitle("foo", "")
	if len(got) != 1 {
		t.Fatalf("FindByTitle: got %d records, want 1", len(got))
	}
	if got[0].ID != id {
		t.Errorf("ID: got %v, want %v", got[0].ID, id)
	}
	if got[0].Path != "notes/Foo.md" {
		t.Errorf("Path: got %q, want %q", got[0].Path, "notes/Foo.md")
	}
}

// TestRegistryFindByTitle_NoMatch verifies empty slice (not nil) when no
// match is found.
func TestRegistryFindByTitle_NoMatch(t *testing.T) {
	t.Parallel()
	r := newTestRegistry()

	got := r.FindByTitle("missing", "")
	if got == nil {
		t.Fatalf("FindByTitle: got nil, want empty slice (not nil)")
	}
	if len(got) != 0 {
		t.Fatalf("FindByTitle: got %d records, want 0", len(got))
	}
}

// TestRegistryFindByTitle_CaseInsensitive verifies that lookup by uppercase
// title returns the record registered under lowercase title.
func TestRegistryFindByTitle_CaseInsensitive(t *testing.T) {
	t.Parallel()
	r := newTestRegistry()
	id := uuid.New()
	r.AddRecord(id, "notes/Foo.md", "foo")

	got := r.FindByTitle("FOO", "")
	if len(got) != 1 {
		t.Fatalf("FindByTitle FOO: got %d records, want 1", len(got))
	}
	if got[0].ID != id {
		t.Errorf("ID: got %v, want %v", got[0].ID, id)
	}
}

// TestRegistryFindByTitle_NFCNormalization verifies that NFC and NFD forms
// of the same title resolve to the same record.
func TestRegistryFindByTitle_NFCNormalization(t *testing.T) {
	t.Parallel()
	r := newTestRegistry()
	id := uuid.New()

	nfcTitle := norm.NFC.String("café")
	r.AddRecord(id, "notes/Café.md", nfcTitle)

	nfdTitle := norm.NFD.String("café")
	got := r.FindByTitle(nfdTitle, "")
	if len(got) != 1 {
		t.Fatalf("FindByTitle NFD: got %d records, want 1; NFC=%q NFD=%q equal?=%v",
			len(got), nfcTitle, nfdTitle, nfcTitle == nfdTitle)
	}
	if got[0].ID != id {
		t.Errorf("ID: got %v, want %v", got[0].ID, id)
	}
}

// TestRegistryFindByTitle_SameFolderBias: when multiple notes share a
// title, the one in sourceFolder appears first, then alphabetical.
func TestRegistryFindByTitle_SameFolderBias(t *testing.T) {
	t.Parallel()
	r := newTestRegistry()
	idA := uuid.New()
	idB := uuid.New()
	idC := uuid.New()

	r.AddRecord(idA, "notes/a/foo.md", "foo")
	r.AddRecord(idB, "notes/b/foo.md", "foo")
	r.AddRecord(idC, "notes/foo.md", "foo")

	got := r.FindByTitle("foo", "notes/b")
	if len(got) != 3 {
		t.Fatalf("FindByTitle: got %d records, want 3", len(got))
	}

	t.Run("same folder first", func(t *testing.T) {
		if got[0].ID != idB {
			t.Errorf("got[0].ID=%v, want idB (%v) — same folder bias", got[0].ID, idB)
		}
		if got[0].Path != "notes/b/foo.md" {
			t.Errorf("got[0].Path=%q, want notes/b/foo.md", got[0].Path)
		}
	})
	t.Run("alphabetical after same-folder", func(t *testing.T) {
		if got[1].Path != "notes/a/foo.md" {
			t.Errorf("got[1].Path=%q, want notes/a/foo.md", got[1].Path)
		}
		if got[2].Path != "notes/foo.md" {
			t.Errorf("got[2].Path=%q, want notes/foo.md", got[2].Path)
		}
	})
}

// TestRegistryFindByTitle_AlphabeticalNoSourceFolder: when sourceFolder is
// "" results are sorted purely alphabetical by canonical path.
func TestRegistryFindByTitle_AlphabeticalNoSourceFolder(t *testing.T) {
	t.Parallel()
	r := newTestRegistry()
	idA := uuid.New()
	idB := uuid.New()
	idC := uuid.New()

	r.AddRecord(idC, "notes/z/foo.md", "foo")
	r.AddRecord(idA, "notes/a/foo.md", "foo")
	r.AddRecord(idB, "notes/m/foo.md", "foo")

	t.Run("alphabetical ordering", func(t *testing.T) {
		got := r.FindByTitle("foo", "")
		if len(got) != 3 {
			t.Fatalf("FindByTitle: got %d records, want 3", len(got))
		}
		if got[0].Path != "notes/a/foo.md" {
			t.Errorf("got[0].Path=%q, want notes/a/foo.md", got[0].Path)
		}
		if got[1].Path != "notes/m/foo.md" {
			t.Errorf("got[1].Path=%q, want notes/m/foo.md", got[1].Path)
		}
		if got[2].Path != "notes/z/foo.md" {
			t.Errorf("got[2].Path=%q, want notes/z/foo.md", got[2].Path)
		}
	})
}

// TestRegistryAddRecord_RemoveUpdatesTitle verifies that Remove cleans the
// title index as well as the id map.
func TestRegistryAddRecord_RemoveUpdatesTitle(t *testing.T) {
	t.Parallel()
	r := newTestRegistry()
	id := uuid.New()
	r.AddRecord(id, "notes/Foo.md", "foo")

	got := r.FindByTitle("foo", "")
	if len(got) != 1 {
		t.Fatalf("before remove: got %d records, want 1", len(got))
	}

	r.Remove(id)
	got = r.FindByTitle("foo", "")
	if got == nil {
		t.Fatalf("after remove: got nil, want empty slice (not nil)")
	}
	if len(got) != 0 {
		t.Fatalf("after remove: got %d records, want 0", len(got))
	}
}

// TestRegistryHydrate_PopulatesMultipleTitles verifies that Hydrate
// populates both the id map and the title index from a slice of
// NoteSummaries containing multiple distinct titles.
func TestRegistryHydrate_PopulatesMultipleTitles(t *testing.T) {
	t.Parallel()
	r := newTestRegistry()
	id1 := uuid.New()
	id2 := uuid.New()
	r.Hydrate([]NoteSummary{
		{ID: id1, Path: "notes/foo.md", Title: "foo"},
		{ID: id2, Path: "notes/bar.md", Title: "bar"},
	})

	got1 := r.FindByTitle("foo", "")
	if len(got1) != 1 || got1[0].ID != id1 {
		t.Errorf("Hydrate foo: got %v", got1)
	}
	got2 := r.FindByTitle("bar", "")
	if len(got2) != 1 || got2[0].ID != id2 {
		t.Errorf("Hydrate bar: got %v", got2)
	}

	path, ok := r.Lookup(id1)
	if !ok || path != "notes/foo.md" {
		t.Errorf("Lookup id1: got %q, %v; want notes/foo.md, true", path, ok)
	}
}

// TestRegistryHydrate_PopulatesTitleIndex verifies that Hydrate (the
// function actually called by the composition root at startup and after
// vault hot-swap / admin reindex — see lifecycle.go and
// admin_reindex_handler.go) populates BOTH byID and byTitle from
// []NoteSummary. Regression: Hydrate used to clear byTitle,
// leaving wiki-link resolution dead after every restart.
func TestRegistryHydrate_PopulatesTitleIndex(t *testing.T) {
	t.Parallel()
	r := &Registry{}
	id := uuid.New()

	r.Hydrate([]NoteSummary{
		{ID: id, Path: "notes/foo.md", Title: "Foo"},
	})

	got := r.FindByTitle("foo", "")
	if len(got) != 1 {
		t.Fatalf("FindByTitle after Hydrate: got %d records, want 1", len(got))
	}
	if got[0].ID != id {
		t.Errorf("ID: got %v, want %v", got[0].ID, id)
	}
}

// TestRegistryRename_UpdatesTitleMap verifies that Rename updates path
// entries in the title index.
func TestRegistryRename_UpdatesTitleMap(t *testing.T) {
	t.Parallel()
	r := newTestRegistry()
	id := uuid.New()
	r.AddRecord(id, "notes/old/foo.md", "foo")

	r.Rename(id, "notes/new/foo.md")

	got := r.FindByTitle("foo", "")
	if len(got) != 1 {
		t.Fatalf("FindByTitle after rename: got %d, want 1", len(got))
	}
	if got[0].Path != "notes/new/foo.md" {
		t.Errorf("Path after rename: got %q, want notes/new/foo.md", got[0].Path)
	}
}
