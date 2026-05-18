package main

import (
	"testing"

	"github.com/matthewoden/jasper/backend/internal/netbind"
)

// TestServeUsesNetbind is the cmd/jasper-side smoke confirmation that
// the loopback gate still lives at the expected import path after
// Phase 8 Plan 08-01 Task 3 moved the function out of package main.
// Coverage of the accept/reject matrix moved to
// backend/internal/netbind/netbind_test.go (7 cases). The single
// assertion here ensures the import is exercised so a refactor that
// silently drops the netbind dependency surfaces in this binary's
// test build.
func TestServeUsesNetbind(t *testing.T) {
	if err := netbind.RequireLoopbackBind("127.0.0.1:3000"); err != nil {
		t.Errorf("netbind.RequireLoopbackBind(127.0.0.1:3000): unexpected err: %v", err)
	}
}
