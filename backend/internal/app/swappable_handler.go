package app

import (
	"net/http"
	"sync/atomic"
)

// swappableHandler is an http.Handler that delegates to an inner Handler
// read atomically on every request. Replaces the previous pattern of
// setting http.Server.Handler at construction time — that captured the
// initial picker-shell handler in no-vault mode, so a later transition
// to vault-open (via the create or open flow) had no way to swap the
// router on the running listener without rebinding the port.
//
// Use:
//
//	sh := newSwappableHandler(initialHandler)
//	srv := &http.Server{Addr: addr, Handler: sh}
//	// Later, from any goroutine:
//	sh.Swap(newRouter)  // every subsequent request uses newRouter
//
// Concurrency: Swap is lock-free via atomic.Pointer. Concurrent
// ServeHTTP reads pick up either the old or new handler in a
// happens-before ordering — a request that started ServeHTTP before
// Swap may finish against the old handler, which is fine; new
// requests after Swap use the new handler.
//
// Nil-safety: if the handler is nil at request time (only possible
// pre-construction via the zero value), respond 503 with a plain-text
// "no handler" so the failure is loud rather than a panic.
type swappableHandler struct {
	inner atomic.Pointer[http.Handler]
}

// newSwappableHandler returns a swappableHandler initialized with the
// given Handler. Callers can swap later via Swap.
func newSwappableHandler(initial http.Handler) *swappableHandler {
	sh := &swappableHandler{}
	sh.Swap(initial)
	return sh
}

// Swap replaces the inner handler. Subsequent requests use the new
// value. Passing nil is permitted (the handler will respond 503 until
// the next non-nil Swap).
func (sh *swappableHandler) Swap(h http.Handler) {
	if h == nil {
		sh.inner.Store(nil)
		return
	}
	sh.inner.Store(&h)
}

// ServeHTTP delegates to whatever handler is currently installed.
func (sh *swappableHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := sh.inner.Load()
	if h == nil {
		http.Error(w, "no handler", http.StatusServiceUnavailable)
		return
	}
	(*h).ServeHTTP(w, r)
}
