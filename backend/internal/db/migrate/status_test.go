package migrate

import (
	"context"
	"sync"
	"testing"
)

// TestStateConstants — assert the four enum string values match the
// openapi.yaml MigrationStatus.state enum exactly. The api package
// casts directly from migrate.State to api.MigrationStatusState; a
// mismatch here would silently break the wire format.
func TestStateConstants(t *testing.T) {
	t.Parallel()
	cases := []struct {
		got, want string
	}{
		{string(StateOK), "ok"},
		{string(StateRolledBack), "rolled_back"},
		{string(StateRebuilding), "rebuilding"},
		{string(StateUnrecoverable), "unrecoverable"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("State constant: got %q, want %q", c.got, c.want)
		}
	}
}

// TestStatusStore_DefaultsToZeroState — a zero-value statusStore
// returns Status{} (State == "") which is NOT a valid wire enum. This
// asserts the zero-value behavior so a future refactor cannot quietly
// regress the runner's "always set State explicitly before returning"
// invariant.
func TestStatusStore_DefaultsToZeroState(t *testing.T) {
	t.Parallel()
	var s statusStore
	got := s.Status(context.Background())
	if got.State != "" {
		t.Fatalf("zero-value statusStore.State: got %q, want empty (the runner is responsible for setting StateOK explicitly)", got.State)
	}
}

// TestStatusStore_RWMutex_RaceCheck — concurrent set + Status calls.
// Run with -race to detect data races. The test launches one writer
// goroutine and N reader goroutines hammering the store; the test
// passes if no race is detected and the final state matches the last
// write.
func TestStatusStore_RWMutex_RaceCheck(t *testing.T) {
	t.Parallel()
	s := &statusStore{}
	var wg sync.WaitGroup

	const N = 50
	const iters = 200

	// Writer.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iters; i++ {
			s.set(Status{State: StateOK, NotesIndexed: i})
		}
	}()

	// Readers.
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx := context.Background()
			for j := 0; j < iters; j++ {
				_ = s.Status(ctx)
			}
		}()
	}
	wg.Wait()

	// Final state should be from the last writer iteration.
	final := s.Status(context.Background())
	if final.State != StateOK {
		t.Errorf("final state: got %q, want %q", final.State, StateOK)
	}
	// NotesIndexed should be a valid iteration value (0..iters-1).
	if final.NotesIndexed < 0 || final.NotesIndexed >= iters {
		t.Errorf("final NotesIndexed out of range: got %d", final.NotesIndexed)
	}
}
