// Package log provides the file-backed slog handler used by the running
// jasper service. Logs to <dataDir>/logs/jasper.log; rotates daily by
// renaming jasper.log → jasper-YYYY-MM-DD.log on the first write of a
// new day (D-39 / PERF-03).
//
// The file logger is wired in app.lifecycle when cfg.Logger is nil — the
// production path. Tests pass a stdout-backed slog.Logger via cfg.Logger
// and the file logger is bypassed.
package log

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// nowFunc is the package-level clock seam so tests can drive rotation
// across a day boundary without sleeping. Production callers leave it
// at time.Now.
var nowFunc = time.Now

// fileSink is the io.Writer that backs the slog JSON handler. It owns
// the open jasper.log file, performs daily rotation, and serializes
// writes via the embedded mutex.
type fileSink struct {
	mu       sync.Mutex
	dir      string
	f        *os.File
	openedOn time.Time // YYYY-MM-DD of currently-open file
	closed   bool
}

// NewFileLogger returns a slog.Logger that writes JSON-encoded records to
// <dataDir>/logs/jasper.log. mkdir -p the logs dir if missing.
//
// Daily rotation: on each Write, if today's date differs from openedOn,
// close the current file, rename jasper.log → jasper-<openedOn>.log,
// open a fresh jasper.log.
//
// Returned io.Closer must be Close()'d on graceful shutdown by the
// caller; once closed, subsequent Writes return os.ErrClosed.
func NewFileLogger(dataDir string) (*slog.Logger, io.Closer, error) {
	logsDir := filepath.Join(dataDir, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return nil, nil, err
	}
	sink := &fileSink{dir: logsDir}
	if err := sink.open(); err != nil {
		return nil, nil, err
	}
	h := slog.NewJSONHandler(sink, &slog.HandlerOptions{Level: slog.LevelInfo})
	return slog.New(h), sink, nil
}

// open (re)opens jasper.log in append mode and records today's date as
// openedOn. Caller must hold mu (or be inside the constructor before
// the sink escapes).
func (s *fileSink) open() error {
	path := filepath.Join(s.dir, "jasper.log")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	s.f = f
	s.openedOn = todayDate()
	return nil
}

// Write implements io.Writer for the slog JSON handler. On the first
// write of a new day it renames the current jasper.log to a dated
// archive file and opens a fresh jasper.log before writing.
func (s *fileSink) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.f == nil {
		return 0, os.ErrClosed
	}
	if today := todayDate(); !sameDay(today, s.openedOn) {
		// Rotate: close current, rename, open fresh.
		_ = s.f.Close()
		oldPath := filepath.Join(s.dir, "jasper.log")
		rotatedPath := filepath.Join(s.dir, "jasper-"+s.openedOn.Format("2006-01-02")+".log")
		_ = os.Rename(oldPath, rotatedPath)
		if err := s.open(); err != nil {
			return 0, err
		}
	}
	return s.f.Write(p)
}

// Close flushes (via the underlying file's Close) and marks the sink
// closed. Idempotent.
func (s *fileSink) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.f == nil {
		s.closed = true
		return nil
	}
	err := s.f.Close()
	s.closed = true
	return err
}

// todayDate returns midnight of today in local time. The rotation gate
// only looks at Y/M/D so the time component is normalized.
func todayDate() time.Time {
	t := nowFunc()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

// sameDay returns true when two times share Y/M/D.
func sameDay(a, b time.Time) bool {
	return a.Year() == b.Year() && a.Month() == b.Month() && a.Day() == b.Day()
}
