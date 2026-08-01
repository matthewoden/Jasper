# ADR-0007 — File-first save path: write, then index, then broadcast

**Status:** Accepted (foundational)

## Context

A note save has to update three things: the file on disk, the SQLite index, and every other connected session. The order is not arbitrary — it determines what a crash in the middle leaves behind.

## Decision

Every write executes in this order, with no exceptions:

1. **`fsstore.WriteAtomic`** — temp file → fsync → rename → fsync parent.
2. **`Index.Upsert`** — update the derived index.
3. **`wshub.Broadcast`** — notify other sessions.

Each step has distinct failure semantics:

- A **file write** failure fails the request. Nothing else runs.
- An **index** failure is recoverable — the file is already correct, and reconcile will fix the index.
- A **broadcast** failure is best-effort. It never fails the write.

Never truncate before confirming a write succeeded.

## Rationale

This ordering is what makes [ADR-0001](./0001-filesystem-is-the-source-of-truth.md) true in practice rather than in principle. A crash after step 1 leaves correct data and a stale index — self-healing. A crash after an index-first write would leave the index claiming content that the file never received.

## Consequences

- **Anything that becomes a fourth step must justify its failure semantics explicitly.** The MCP audit log, for example, must be modeled on the broadcast (fire-and-forget, after the response) rather than on the file write (must-succeed) — an audit failure must never fail or roll back a note write.
- Optimistic locking via `If-Match` compares the file's modification time, snapshotted when the client loaded the note. A mismatch is a 409 surfaced as a save-conflict banner.
- A second editing surface over the same bytes cannot invent its own write path — it would race the first. See [ADR-0016](./0016-shared-document-single-writer.md).
- The WebSocket hub never holds a lock across I/O, so a slow client cannot stall a write.
