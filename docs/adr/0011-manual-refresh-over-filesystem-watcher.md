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

## Re-examined and upheld (2026-08-22)

Reopened by a durability audit finding: Jasper now runs 24/7 as a launchd agent or systemd user unit, and [ADR-0003](./0003-single-user-no-auth.md) makes external sync the cross-device answer — so a vault living in a Dropbox/iCloud/Syncthing folder is the documented deployment, not an edge case. Reconcile runs at startup, on vault switch, and on manual reindex, never while running, so an external edit is invisible for as long as the app stays open. That is a sharper version of the "accepted" consequence above than this ADR originally weighed.

**The decision stands. Detection remains on-demand.** What changed is the evidence behind it, recorded here so this is not re-litigated from intuition:

- **A periodic reconcile was measured, not estimated.** A warm no-change incremental reconcile costs **~23 ms on a 1,000-note vault and ~105 ms on 5,000** (dev Mac, mean of 5 runs). A 2–5 second poll is affordable. It was declined as unnecessary for a single-user app whose user knows when they edited elsewhere — not as too expensive. If that judgement changes, the cost is known and a timer is the cheap answer.
- **A timer would not have violated this ADR anyway.** The objection above is to a second *event source* requiring feedback-loop suppression. Reconcile compares index state against disk state rather than reacting to an event, so Jasper's own writes are already indexed by the time a scan runs and produce no delta. It is self-suppressing by construction. A watcher is what this ADR rejects; polling was never the same thing.
- **inotify does not fire for changes on a Windows drive mounted into WSL** (`/mnt/c`), only for edits inside the Linux filesystem. A watcher would not see external edits for a coworker keeping a vault there, so it would not fully solve the problem it would be overriding this ADR to solve — the manual path would still be needed.
- **The fallback this ADR describes did not exist.** "An explicit Refresh action in the sidebar toolbar" was never built; manual reindex was reachable only by clicking the save-state indicator in the status bar, which wears a cloud icon and reads as save status. A decision whose accepted consequence is "the user refreshes" requires the refresh to be findable. That is now its own work rather than a claim in this document.
- **Refresh re-reads open notes, and never merges.** A tab with no unsaved changes reloads; a tab with unsaved changes is left untouched and surfaces the existing save-conflict affordance. Obsidian merges external changes into the open buffer automatically, but that behavior is coupled to live watching and carries a documented tail of data-loss reports — [ADR-0019](./0019-obsidian-as-default-ux-reference.md) governs feel, not architecture, and there is no Obsidian refresh gesture to copy in any case.
