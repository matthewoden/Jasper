# ADR-0021 — Config partial writes via `PATCH`, ordered by server-side serialisation

**Status:** Accepted 2026-07-26

## Context

Every Settings control saved by spreading the whole config object it currently held and `PUT`ting all of it back.

That means a second edit firing before the first response refreshes that copy carries a **stale base** — and silently reverts the first field. No error, nothing visible until reload. The same defect had already surfaced as a flaky E2E folder-write race, which is evidence it was reachable in practice, not theoretical.

A dirty check alone was explicitly rejected as a partial fix: it removes no-op writes but leaves the stale-base spread intact, so the finding would look closed while the dangerous half survived.

## Decision

1. **Partial writes get a new `PATCH /config` verb.** `PUT /config` is retained for per-section Reset, where replacing a whole section is the actual intent.
2. **Ordering is guaranteed by server-side serialisation** — a handler mutex, read-modify-write under lock.

## Alternatives rejected

| Option | Why not |
|---|---|
| **`If-Match` optimistic concurrency** | Pushes retry handling into every Settings pane. A 409 on a config write is not something a user can act on meaningfully. |
| **Client-side write queue** | Single-tab only. Settings is reachable from multiple sessions, so a per-tab queue doesn't order writes from two tabs. |
| **Dirty check alone** | Removes redundant writes without fixing the stale base. Looks like a fix; isn't one. |

## Consequences

- The server is the ordering authority. Two panes editing different fields concurrently both land, because each `PATCH` reads current state under the lock rather than carrying a client snapshot.
- `PATCH` needs an all-pointer validator twin (`strictConfigPatchValidator`) so an omitted field is distinguishable from a zero value. Both validators are guarded against drift from `config.Config` by a test.
- The lock is per-handler, held across a read-modify-write of a small JSON file. Fine at this scale; it would not be at a larger one.

## The generalizable point

**Half-fixing a race makes it worse than not fixing it**, because the finding gets marked closed. When a defect has two mechanisms, either address both or explicitly record which one is still open — this was deliberately *not* folded into a code-review fix pass for exactly that reason.
