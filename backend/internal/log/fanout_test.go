package log

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

// failingHandler reports Enabled for everything and always errors from
// Handle — used to prove a fanout keeps delivering to its other children
// when one of them fails.
type failingHandler struct{ calls *int }

func (h failingHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h failingHandler) Handle(context.Context, slog.Record) error {
	*h.calls++
	return errors.New("boom")
}
func (h failingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h failingHandler) WithGroup(string) slog.Handler      { return h }

// TestFanout_DeliversToEveryHandler is the core of the tee: one Info call
// lands in both sinks.
func TestFanout_DeliversToEveryHandler(t *testing.T) {
	var console, file bytes.Buffer
	logger := slog.New(Fanout(
		slog.NewTextHandler(&console, nil),
		slog.NewJSONHandler(&file, nil),
	))

	logger.Info("hello", "k", "v")

	if !strings.Contains(console.String(), "hello") {
		t.Errorf("console sink missing record: %q", console.String())
	}
	if !strings.Contains(file.String(), `"msg":"hello"`) {
		t.Errorf("file sink missing record: %q", file.String())
	}
}

// TestFanout_FailingChildDoesNotStarveOthers — a file sink that has been
// closed under us (post-teardown writes) must not silence the console.
func TestFanout_FailingChildDoesNotStarveOthers(t *testing.T) {
	var console bytes.Buffer
	calls := 0
	logger := slog.New(Fanout(
		failingHandler{calls: &calls},
		slog.NewTextHandler(&console, nil),
	))

	logger.Info("still-logged")

	if calls != 1 {
		t.Errorf("failing handler calls: got %d, want 1", calls)
	}
	if !strings.Contains(console.String(), "still-logged") {
		t.Errorf("console sink starved by failing sibling: %q", console.String())
	}
}

// TestFanout_EnabledIsUnionOfChildren — the fanout must not swallow a
// level one child accepts just because another rejects it. Console runs
// at Warn, file at Info; an Info record must still reach the file.
func TestFanout_EnabledIsUnionOfChildren(t *testing.T) {
	var console, file bytes.Buffer
	h := Fanout(
		slog.NewTextHandler(&console, &slog.HandlerOptions{Level: slog.LevelWarn}),
		slog.NewJSONHandler(&file, &slog.HandlerOptions{Level: slog.LevelInfo}),
	)
	if !h.Enabled(context.Background(), slog.LevelInfo) {
		t.Fatal("Enabled(Info): got false, want true (file child accepts Info)")
	}

	slog.New(h).Info("info-only")

	if console.Len() != 0 {
		t.Errorf("Warn-level console sink received an Info record: %q", console.String())
	}
	if !strings.Contains(file.String(), "info-only") {
		t.Errorf("file sink missing Info record: %q", file.String())
	}
}

// TestFanout_WithAttrsAndGroupReachEveryChild — slog derives loggers via
// WithAttrs/WithGroup, so a fanout that drops them on the floor would
// silently lose fields on `logger.With(...)` call sites.
func TestFanout_WithAttrsAndGroupReachEveryChild(t *testing.T) {
	var a, b bytes.Buffer
	logger := slog.New(Fanout(
		slog.NewJSONHandler(&a, nil),
		slog.NewJSONHandler(&b, nil),
	)).With("vault", "/tmp/v").WithGroup("g")

	logger.Info("msg", "inner", 1)

	for name, buf := range map[string]*bytes.Buffer{"a": &a, "b": &b} {
		s := buf.String()
		if !strings.Contains(s, `"vault":"/tmp/v"`) {
			t.Errorf("sink %s missing WithAttrs attr: %q", name, s)
		}
		if !strings.Contains(s, `"g":{"inner":1}`) {
			t.Errorf("sink %s missing WithGroup nesting: %q", name, s)
		}
	}
}

// TestFanout_IgnoresNilHandlers — the app passes a console handler that
// may be absent in stripped-down test wiring; a nil child must not panic.
func TestFanout_IgnoresNilHandlers(t *testing.T) {
	var file bytes.Buffer
	logger := slog.New(Fanout(nil, slog.NewJSONHandler(&file, nil)))

	logger.Info("survived")

	if !strings.Contains(file.String(), "survived") {
		t.Errorf("record lost alongside nil handler: %q", file.String())
	}
}

// TestFanout_NoHandlersIsInert — Fanout() with nothing to fan out to must
// be a working no-op handler, not a nil dereference.
func TestFanout_NoHandlersIsInert(t *testing.T) {
	h := Fanout()
	if h.Enabled(context.Background(), slog.LevelError) {
		t.Error("empty fanout Enabled: got true, want false")
	}
	slog.New(h).Error("nowhere")
}
