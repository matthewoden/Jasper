package notes

import (
	"sync"

	"github.com/google/uuid"
)

// keyedMutex serializes writers per note UUID.
//
// If-Match is a check-then-act: Stat, compare, WriteAtomic. Without this,
// two writers holding the same valid comparator both pass the compare before
// either writes, and one write is silently destroyed. REST (6683) and MCP
// (6684) are independent listeners into the same Service, so the race needs no
// second browser tab to happen.
//
// Locks are refcounted and dropped when the last holder releases, so a vault
// with 100k notes does not accumulate 100k mutexes.
type keyedMutex struct {
	mu    sync.Mutex
	locks map[uuid.UUID]*refCountedLock
}

type refCountedLock struct {
	mu   sync.Mutex
	refs int
}

func newKeyedMutex() *keyedMutex {
	return &keyedMutex{locks: make(map[uuid.UUID]*refCountedLock)}
}

// lock blocks until this note's write lock is held, and returns the unlock.
// Callers must never hold two of these at once — every acquisition in this
// package is lock/write/unlock within one function, which is what keeps the
// lock order irrelevant and the whole thing deadlock-free.
func (k *keyedMutex) lock(id uuid.UUID) func() {
	k.mu.Lock()
	l, ok := k.locks[id]
	if !ok {
		l = &refCountedLock{}
		k.locks[id] = l
	}
	l.refs++
	k.mu.Unlock()

	l.mu.Lock()

	return func() {
		l.mu.Unlock()
		k.mu.Lock()
		l.refs--
		if l.refs == 0 {
			delete(k.locks, id)
		}
		k.mu.Unlock()
	}
}
