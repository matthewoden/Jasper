# ADR-0011 — Manual refresh instead of a filesystem watcher

**Status:** Accepted (per `DESIGN.md` §5.2)

## Context

External tools legitimately edit the vault — Syncthing, git, another markdown editor, the OS file manager. Jasper needs to notice.

The obvious mechanism is an `fsnotify` watcher on `notes/`.

## Decision

No filesystem watcher. External changes are picked up by:

- an **incremental reconcile at startup** ([ADR-0012](./0012-incremental-reindex-on-startup.md)), and
- an explicit **Refresh** action in the sidebar toolbar.

## Rationale

A watcher would create a second event source alongside the WebSocket hub, and the two are indistinguishable at the point of consumption. Jasper's own writes hit the disk, so the watcher fires on them too — which means every write needs feedback-loop suppression: track which paths we just wrote, ignore events for them, handle the race where an external edit lands in that same window.

That suppression logic is subtle, and getting it wrong produces either missed external edits or self-inflicted refresh loops. Dropping the watcher eliminates the ambiguity entirely: the WebSocket hub is the *only* push source, and it only ever carries changes Jasper made.

## Consequences

- An external edit is invisible until the user refreshes or restarts. Accepted — this is a single-user desktop app, and the user generally knows when they've edited a file elsewhere.
- The refresh path must be cheap enough to use freely, which it is: reconcile is a delta scan, not a rebuild.
- The `Broadcaster` contract stays simple. Every event has a known origin session, so the sender can be excluded and no event needs "did we cause this?" disambiguation.
- If a watcher is ever reconsidered, the feedback-loop suppression is the cost to price in — not the watcher itself.
