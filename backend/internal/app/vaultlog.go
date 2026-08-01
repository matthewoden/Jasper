package app

import (
	"context"
	"log/slog"
	"sync/atomic"

	jlog "github.com/matthewoden/jasper/backend/internal/log"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

// vaultLogHandler is the stable handler behind cfg.Logger. Records route to
// whichever handler is installed when they are logged, so cfg.Logger itself
// is assigned once in New and never again — SwitchVault runs on an HTTP
// goroutine, and reassigning the field there would race every reader.
//
// It also means subsystems wired with the logger for vault A follow the
// swap to vault B instead of holding a handler over a closed file.
type vaultLogHandler struct {
	installed *atomic.Pointer[slog.Handler]
	// derive replays this handler's WithAttrs/WithGroup chain onto whatever
	// is installed at log time. Nil for the undecorated handler, which is
	// the overwhelmingly common case.
	derive func(slog.Handler) slog.Handler
}

func newVaultLogHandler(initial slog.Handler) *vaultLogHandler {
	installed := &atomic.Pointer[slog.Handler]{}
	installed.Store(&initial)
	return &vaultLogHandler{installed: installed}
}

func (h *vaultLogHandler) install(next slog.Handler) { h.installed.Store(&next) }

func (h *vaultLogHandler) live() slog.Handler {
	live := *h.installed.Load()
	if h.derive != nil {
		live = h.derive(live)
	}
	return live
}

func (h *vaultLogHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.live().Enabled(ctx, level)
}

func (h *vaultLogHandler) Handle(ctx context.Context, r slog.Record) error {
	return h.live().Handle(ctx, r)
}

func (h *vaultLogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return h.chain(func(next slog.Handler) slog.Handler { return next.WithAttrs(attrs) })
}

func (h *vaultLogHandler) WithGroup(name string) slog.Handler {
	return h.chain(func(next slog.Handler) slog.Handler { return next.WithGroup(name) })
}

func (h *vaultLogHandler) chain(step func(slog.Handler) slog.Handler) slog.Handler {
	prev := h.derive
	return &vaultLogHandler{
		installed: h.installed,
		derive: func(next slog.Handler) slog.Handler {
			if prev != nil {
				next = prev(next)
			}
			return step(next)
		},
	}
}

// attachVaultFileLog opens dataDir's log file and routes cfg.Logger to
// console+file.
//
// Unconditional by contract: the caller supplies the *console* handler and
// the vault's file handler is always added to it. Called once per vault
// open, so a hot-swap gets vault B's file.
func (a *App) attachVaultFileLog(dataDir string) error {
	fileHandler, closer, err := jlog.NewFileHandler(vault.LogsDir(dataDir))
	if err != nil {
		return err
	}
	// Only once the replacement is open, so a failure above leaves the
	// current vault's log intact.
	if cerr := a.detachVaultFileLog(); cerr != nil {
		a.cfg.Logger.Warn("closing the previous vault log failed (continuing)", "err", cerr)
	}
	a.fileLogCloser = closer
	a.vaultLog.install(jlog.Fanout(a.consoleHandler, fileHandler))
	return nil
}

// detachVaultFileLog closes the vault's log file and drops back to
// console-only. Re-routing is the half that used to be missing: closing the
// sink alone left every later record writing into a closed file.
// Idempotent.
func (a *App) detachVaultFileLog() error {
	if a.fileLogCloser == nil {
		return nil
	}
	err := a.fileLogCloser.Close()
	a.fileLogCloser = nil
	a.vaultLog.install(a.consoleHandler)
	return err
}
