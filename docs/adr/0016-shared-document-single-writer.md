# ADR-0016 — One document, many views: a module-singleton buffer with a single undo owner

**Status:** Accepted

## Context

The workspace is a tree of split panes, and several panes can show the same note. That makes N live CodeMirror `EditorView`s over one underlying document, which raises two problems:

1. **Divergent state.** If each pane owns its own content, save timer, and WebSocket reconciliation, the panes can disagree about what the note says.
2. **Undo ownership.** CodeMirror's undo history lives on a view. If the pane that owns it closes, the history goes with it.

An empirical spike settled the second problem before any dependent code was written: **`Compartment.reconfigure` loses undo history** — the swapped-in `history()` brings a fresh private StateField that has never seen the earlier edits — so promoting another view by reconfiguring it was rejected on evidence rather than argued about. The spike is checked in as `frontend/src/lib/sharedDocRegistry.spike.test.ts` and earns its place by pinning that upstream behavior; if CodeMirror ever changes it, this decision is worth revisiting.

## Decision

- One note's content, save, debounce, flush, and WebSocket reconciliation are owned by **`noteBufferController`** — a React-free module singleton, keyed per note. Not React state.
- N views mirror one document through `sharedDocRegistry`, dispatching changes-only re-dispatch with a sync guard.
- The **undo timeline stays on a single owning view**, which is kept alive off-DOM when its pane closes rather than being reconfigured away.

## Rationale

Lifting the buffer out of React state makes "no divergent state across panes" **true by construction rather than by convention**. There is no code path in which two panes hold different content, because there is only one holder.

This is the general shape worth reusing: when an invariant spans several UI instances, make it structural — a module singleton that owns the thing — instead of a rule that every instance must remember to follow.

## Consequences

- **Any second editing surface over the same bytes must route through this controller.** A Properties table editing frontmatter is editing the same file the body editor has open; giving it an independent write path reincarnates exactly the divergent-state race this decision exists to prevent — plus stale `If-Match` conflicts the user can't explain ("I didn't touch that field, why did my edit fail?").
- Flush is explicit and must be awaited before anything that discards pending state. Tab close does not fire blur; without an awaited flush, a mid-debounce edit is silently lost.
- Programmatic document edits — the H1 rewrite, checkbox toggles — dispatch as CodeMirror transactions through the same pipeline, so they inherit the same save, broadcast, and undo semantics.
- Multi-view correctness needs regression coverage that actually opens two panes; single-pane tests cannot see these bugs.
