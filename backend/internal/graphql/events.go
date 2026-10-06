package graphql

import (
	"sync"
	"time"

	"github.com/matthewoden/jasper/backend/internal/graphql/model"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Events tees every broadcast to the browser hub into a pub/sub the
// itemChanged subscription reads. It sits in front of the hub as the
// service's Broadcaster, so the hub's contract (origin filtering, slow-client
// drop) is untouched and the service never knows two audiences exist.
type Events struct {
	inner notes.Broadcaster
	mu    sync.Mutex
	subs  map[chan *model.ItemChange]struct{}
	now   func() time.Time
}

// NewEvents wraps inner; a nil inner is allowed and means no browser hub.
func NewEvents(inner notes.Broadcaster) *Events {
	return &Events{inner: inner, subs: map[chan *model.ItemChange]struct{}{}, now: time.Now}
}

// Broadcast forwards to the hub and then publishes the change, after, so a
// subscriber that reacts by reading sees the same state the browser does.
func (e *Events) Broadcast(eventType string, payload any, originSessionID string) {
	if e.inner != nil {
		e.inner.Broadcast(eventType, payload, originSessionID)
	}
	if change := changeFromEvent(eventType, payload, e.now()); change != nil {
		e.publish(change)
	}
}

// Subscribe returns a channel that receives every change until unsubscribe
// is called. A subscriber that falls more than a buffer behind misses
// changes rather than holding up the writer.
func (e *Events) Subscribe() (<-chan *model.ItemChange, func()) {
	ch := make(chan *model.ItemChange, 64)
	e.mu.Lock()
	e.subs[ch] = struct{}{}
	e.mu.Unlock()
	return ch, func() {
		e.mu.Lock()
		if _, ok := e.subs[ch]; ok {
			delete(e.subs, ch)
			close(ch)
		}
		e.mu.Unlock()
	}
}

func (e *Events) publish(change *model.ItemChange) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for ch := range e.subs {
		select {
		case ch <- change:
		default:
		}
	}
}

func changeFromEvent(eventType string, payload any, at time.Time) *model.ItemChange {
	fields, _ := payload.(map[string]any)
	idOf := func(key string) string {
		s, _ := fields[key].(string)
		return s
	}
	var id string
	var kind model.ItemChangeKind
	switch eventType {
	case notes.EventNoteCreated:
		id, kind = idOf("id"), model.ItemChangeKindCreated
	case notes.EventNoteUpdated:
		id, kind = idOf("id"), model.ItemChangeKindUpdated
	case notes.EventNoteDeleted:
		id, kind = idOf("id"), model.ItemChangeKindDeleted
	case notes.EventNoteMoved:
		id, kind = idOf("id"), model.ItemChangeKindMoved
	case notes.EventRefsChanged:
		id, kind = idOf("source_id"), model.ItemChangeKindRefsChanged
	default:
		return nil
	}
	if id == "" {
		return nil
	}
	return &model.ItemChange{ID: notes.RefForNote(notes.ID(id)), Change: kind, At: at.UTC()}
}
