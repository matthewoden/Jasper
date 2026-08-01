package log

import (
	"context"
	"log/slog"
)

// Fanout returns a slog.Handler that forwards every record to each of the
// supplied handlers. Nil handlers are dropped; Fanout() with nothing live
// is an inert handler rather than a nil dereference.
//
// The tee lives at the handler level rather than the writer level so that
// the rotating fileSink stays the sole owner of its file handle — daily
// rotate-on-write never has to coordinate with a second writer, which an
// io.MultiWriter tee would have forced.
func Fanout(handlers ...slog.Handler) slog.Handler {
	live := make([]slog.Handler, 0, len(handlers))
	for _, h := range handlers {
		if h != nil {
			live = append(live, h)
		}
	}
	if len(live) == 1 {
		return live[0]
	}
	return fanoutHandler{handlers: live}
}

type fanoutHandler struct{ handlers []slog.Handler }

// Enabled is the union of the children: a level one sink accepts must not
// be dropped because a quieter sibling rejects it. Handle re-checks per
// child so the quieter sibling still never sees it.
func (f fanoutHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, h := range f.handlers {
		if h.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

// Handle delivers to every enabled child even if an earlier one fails: a
// file sink closed under us during a vault swap must not silence the
// console.
func (f fanoutHandler) Handle(ctx context.Context, r slog.Record) error {
	var firstErr error
	for _, h := range f.handlers {
		if !h.Enabled(ctx, r.Level) {
			continue
		}
		if err := h.Handle(ctx, r.Clone()); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (f fanoutHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return f
	}
	out := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		out[i] = h.WithAttrs(attrs)
	}
	return fanoutHandler{handlers: out}
}

func (f fanoutHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return f
	}
	out := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		out[i] = h.WithGroup(name)
	}
	return fanoutHandler{handlers: out}
}
