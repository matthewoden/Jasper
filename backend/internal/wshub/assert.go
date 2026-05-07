package wshub

import "github.com/matthewoden/jasper/backend/internal/notes"

// Compile-time assertion: *Hub satisfies notes.Broadcaster.
//
// This is the Plan 04-04 interface-satisfaction check — if Hub's
// Broadcast signature ever drifts from the notes.Broadcaster port, this
// line produces a compile error (not a runtime panic). The dependency
// direction is correct: wshub → notes (notes does NOT import wshub).
//
// Pitfall 6 check: Hub.Broadcast holds RLock during fan-out; closeSlow
// is invoked in a goroutine so it can acquire Lock without deadlocking
// on the held RLock. Both are verified in hub_test.go (race detector
// clean per Plan 04-02 SUMMARY.md).
var _ notes.Broadcaster = (*Hub)(nil)
