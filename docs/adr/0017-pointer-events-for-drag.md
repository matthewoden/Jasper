# ADR-0017 — All drag interactions use pointer events, never native HTML5 DnD

**Status:** Accepted (learned twice, the hard way)

## Context

Jasper has a lot of dragging: file-tree drag-and-drop, tab reordering, cross-pane tab moves, drag-to-split, pane divider resizing, bookmark reordering.

Tab reorder originally shipped on native HTML5 drag-and-drop. It did not work — the drop event never fired.

Worse: **the round-one "fix" passed its tests.** The test drove synthetic `DragEvent`s, which the handlers consumed happily while the real browser never dispatched them. A green suite certified a broken feature.

## Decision

Every drag interaction is implemented with **pointer events**. Native HTML5 drag-and-drop is not used.

Verification standard: drive real `page.mouse` gestures in Playwright against a **rebuilt binary** (`make build`). Synthetic `DragEvent`s are not acceptable evidence that a drag works.

## Rationale

Native DnD proved unreliable in this app's DOM, and — more damagingly — untestable in a way that produced false confidence. Pointer events are reliable here and are driven identically by tests and by a real user, which closes the gap between "the test passes" and "it works."

## Consequences

- The whole v1.3 split-pane interaction layer (drag-to-split, drag-to-move, divider resize) is pointer-based, verified with real-mouse Playwright at `--repeat-each=3`.
- One known gap: `react-arborist`'s `onMove` does not fire for drops on empty tree area. Drag-to-root is handled with explicit window-level drag listeners rather than through the library's callback.
- Any new drag affordance inherits this decision. Reaching for `draggable=true` is a signal to stop.

## The broader lesson

Recorded in the v1.1 retrospective and applicable well beyond drag:

> **When a known-reliable implementation path exists, take it first.** Native DnD was already suspect; shipping on it and re-doing it on pointer events cost a full round that "use the reliable thing up front" would have saved.

And its companion, from v1.0 through v1.3 without exception: **the bug is found by the real surface** — `bin/jasper`, a real mouse, a real click, rendered glyph rects — not by the test runner. A test that measures the wrong thing is worse than no test, because it certifies the defect.
