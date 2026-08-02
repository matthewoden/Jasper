package notes

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// mtimeTrackingFileStore behaves like a real filesystem for the one property
// If-Match depends on: Stat reports the mtime the last WriteAtomic produced.
//
// The clock advances a fixed step per write rather than reading wall time, so
// these tests never depend on filesystem timestamp granularity or on two writes
// landing in different nanoseconds. The embedded fake supplies the rest of the
// port; only the three methods the comparator touches are overridden.
type mtimeTrackingFileStore struct {
	*fakeFileStore

	mu         sync.Mutex
	mtime      time.Time
	content    []byte
	writeCalls int
}

func newMtimeTrackingFileStore(start time.Time, content string) *mtimeTrackingFileStore {
	return &mtimeTrackingFileStore{
		fakeFileStore: &fakeFileStore{},
		mtime:         start,
		content:       []byte(content),
	}
}

func (f *mtimeTrackingFileStore) Read(_ string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.content...), nil
}

func (f *mtimeTrackingFileStore) WriteAtomic(_ string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writeCalls++
	f.content = append([]byte(nil), data...)
	f.mtime = f.mtime.Add(time.Millisecond)
	return nil
}

func (f *mtimeTrackingFileStore) Stat(_ string) (time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.mtime, nil
}

func (f *mtimeTrackingFileStore) currentETag() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return ETag(f.mtime)
}

// Two writers holding the same valid comparator. Without a per-note lock both
// Stat before either writes, both pass the compare, and one write is silently
// destroyed — REST and MCP are independent listeners, so this needs no second
// browser tab.
//
// Repeated because the unserialized failure is a race, not a certainty.
func TestService_Update_ConcurrentSameIfMatch_ExactlyOneWins(t *testing.T) {
	t.Parallel()

	const rounds = 100
	for round := 0; round < rounds; round++ {
		files := newMtimeTrackingFileStore(
			time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC),
			"---\ntags: []\n---\n\noriginal\n",
		)
		svc := newSvcWithBroadcaster(t, files, &fakeIndex{}, &fakeBroadcaster{})

		ifMatch := files.currentETag()

		var (
			start    sync.WaitGroup
			done     sync.WaitGroup
			mu       sync.Mutex
			okCount  int
			staleErr int
			otherErr []error
		)
		start.Add(1)
		for i := 0; i < 2; i++ {
			done.Add(1)
			go func(n int) {
				defer done.Done()
				start.Wait()
				_, err := svc.Update(
					context.Background(),
					ScratchpadUUID,
					"---\ntags: []\n---\n\nwriter "+string(rune('A'+n))+"\n",
					ifMatch,
				)
				mu.Lock()
				defer mu.Unlock()
				switch {
				case err == nil:
					okCount++
				case errors.Is(err, ErrStaleWrite):
					staleErr++
				default:
					otherErr = append(otherErr, err)
				}
			}(i)
		}
		start.Done()
		done.Wait()

		if len(otherErr) != 0 {
			t.Fatalf("round %d: unexpected errors: %v", round, otherErr)
		}
		if okCount != 1 || staleErr != 1 {
			t.Fatalf("round %d: got %d success / %d stale, want exactly 1 / 1 "+
				"(both succeeding means the check-then-act window is unserialized)",
				round, okCount, staleErr)
		}
		if files.writeCalls != 1 {
			t.Fatalf("round %d: writeCalls = %d, want 1 — the rejected writer must not touch disk",
				round, files.writeCalls)
		}
	}
}

// Update's frontmatter rewriteback writes a SECOND time, after the response
// comparator would naively have been computed. If the returned mtime predates
// that write, the first autosave after every note load 409s. Content with no
// frontmatter is what triggers the rewriteback.
func TestService_Update_ETagRoundTrips(t *testing.T) {
	t.Parallel()

	svc, _, _ := newRealFSSvc(t)
	summary, err := svc.Create(context.Background(), "", "roundtrip")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Save 1 — no frontmatter in the body, so the service injects it.
	first, err := svc.Update(context.Background(), summary.ID, "# Roundtrip\n\n#inline-tag\n", "")
	if err != nil {
		t.Fatalf("first Update: %v", err)
	}

	// Save 2 uses save 1's token, exactly as an autosave would.
	if _, err := svc.Update(
		context.Background(), summary.ID, "# Roundtrip\n\nsecond\n", ETag(first.UpdatedAt),
	); err != nil {
		t.Fatalf("second Update must accept the first response's etag, got: %v", err)
	}
}

// The token a client seeds on load must be the one Update compares against —
// what a truncated-to-seconds index-backed updated_at could never satisfy.
func TestService_Get_ETagIsAcceptedByUpdate(t *testing.T) {
	t.Parallel()

	svc, _, _ := newRealFSSvc(t)
	summary, err := svc.Create(context.Background(), "", "seeded")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	loaded, err := svc.Get(context.Background(), summary.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if _, err := svc.Update(
		context.Background(), summary.ID, "---\ntags: []\n---\n\n# Seeded\n\nedited\n", ETag(loaded.UpdatedAt),
	); err != nil {
		t.Fatalf("Update must accept the etag from Get, got: %v", err)
	}

	// A second-truncated comparator is precisely what a client seeding from
	// /tree or a tag list would send. It must be rejected, not quietly honored.
	stale, err := svc.Get(context.Background(), summary.ID)
	if err != nil {
		t.Fatalf("Get after update: %v", err)
	}
	truncated := ETag(stale.UpdatedAt.Truncate(time.Second))
	if truncated == ETag(stale.UpdatedAt) {
		t.Skip("mtime landed on an exact second; truncation is indistinguishable this run")
	}
	_, err = svc.Update(context.Background(), summary.ID, "body\n", truncated)
	if !errors.Is(err, ErrStaleWrite) {
		t.Fatalf("second-precision comparator must be rejected as stale, got: %v", err)
	}
}

// The index emits one row per backlink, so a note with two refs to the same
// target appears twice — and a second lock() on a UUID this goroutine already
// holds would deadlock the whole pass.
func TestService_RenameRewriteWikilinks_DuplicateReferrerRows(t *testing.T) {
	t.Parallel()

	svc, _, idx := newRealFSSvc(t)
	referrer, err := svc.CreateWithBody(
		context.Background(), "", "referrer", "See [[Old Title]] and again [[Old Title]].\n",
	)
	if err != nil {
		t.Fatalf("CreateWithBody: %v", err)
	}

	// Two rows for one note, which is what a two-link body really produces.
	idx.backlinkSources = []NoteSummary{
		{ID: referrer.ID, Path: referrer.Path, Title: referrer.Title},
		{ID: referrer.ID, Path: referrer.Path, Title: referrer.Title},
	}

	doneCh := make(chan []string, 1)
	go func() {
		touched, rwErr := svc.RenameRewriteWikilinks(context.Background(), "Old Title", "New Title")
		if rwErr != nil {
			doneCh <- nil
			return
		}
		out := make([]string, len(touched))
		for i, id := range touched {
			out[i] = id.String()
		}
		doneCh <- out
	}()

	select {
	case touched := <-doneCh:
		if touched == nil {
			t.Fatal("RenameRewriteWikilinks returned an error")
		}
		if len(touched) != 1 {
			t.Errorf("touched IDs: got %d, want 1 (duplicate rows must collapse)", len(touched))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RenameRewriteWikilinks deadlocked on a duplicate referrer row")
	}
}

// encoding/json renders time.Time as RFC3339Nano, so a client echoing back the
// etag string it was handed must match the comparator byte-for-byte.
func TestETagMatchesJSONEncoding(t *testing.T) {
	t.Parallel()

	cases := []time.Time{
		time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC),
		time.Date(2026, 5, 1, 12, 0, 0, 123456789, time.UTC),
		time.Date(2026, 5, 1, 12, 0, 0, 100000000, time.UTC),
		time.Date(2026, 5, 1, 12, 0, 0, 1, time.UTC),
	}
	for _, tc := range cases {
		encoded, err := tc.MarshalJSON()
		if err != nil {
			t.Fatalf("MarshalJSON(%v): %v", tc, err)
		}
		want := strings.Trim(string(encoded), `"`)
		if got := ETag(tc); got != want {
			t.Errorf("ETag(%v) = %q, want %q (JSON encoding)", tc, got, want)
		}
	}
}
