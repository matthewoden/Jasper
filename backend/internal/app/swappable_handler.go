package app

import (
	"net/http"
	"sync/atomic"
)

type swappableHandler struct {
	inner atomic.Pointer[http.Handler]
}

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
