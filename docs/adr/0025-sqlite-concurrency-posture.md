# ADR-0025 — SQLite concurrency: one writer, a reader pool, WAL

**Status:** Accepted (foundational — v1.0, from `DESIGN.md`)

## Context

SQLite permits one writer at a time. Go's `database/sql` hands out pooled connections, so a naive single `*sql.DB` will happily start two write transactions and produce `SQLITE_BUSY` under concurrent saves — which, in this app, means a user's note failing to save while another request holds the write lock.

Jasper has genuine write concurrency: an HTTP save, a background reconcile, and an MCP tool call can all want the database at once.

## Decision

**Two `*sql.DB` handles against the same file**, not one:

- a **writer** with `MaxOpenConns(1)` — the pool *is* the write lock
- a **reader pool** for everything else

Every write transaction opens with **`BEGIN IMMEDIATE`**, taking the write lock up front rather than on first write.

Both handles apply, on every connection:

| Pragma | Value | Why |
|---|---|---|
| `journal_mode` | `WAL` | Readers don't block the writer and vice versa |
| `synchronous` | `NORMAL` | Safe under WAL; full fsync per commit is unnecessary given the index is derived |
| `busy_timeout` | `5000` | Wait rather than fail immediately on contention |
| `wal_autocheckpoint` | `1000` | Bound WAL growth without manual checkpointing |

## Rationale

`MaxOpenConns(1)` makes serialization structural. There's no lock discipline to remember and no path by which two writers coexist, because the pool cannot produce a second connection.

`BEGIN IMMEDIATE` matters for the deferred-transaction upgrade problem: a transaction that starts deferred and *becomes* a writer mid-way can fail to upgrade if another writer arrived first, and it fails partway through work already done. Taking the lock at the start converts a mid-transaction failure into an up-front wait.

`synchronous=NORMAL` is defensible precisely because of [ADR-0001](./0001-filesystem-is-the-source-of-truth.md) — the worst case for a lost SQLite commit is a stale index, which reconcile repairs. The notes themselves are protected by atomic file writes, not by this database.

## Consequences

- Write throughput is capped by design. Fine for a single-user app; it would not be for a multi-tenant one.
- Long-running writes block other writes for up to `busy_timeout`. Keep write transactions short — in particular, never hold one across filesystem I/O.
- The WebSocket hub follows the same discipline for a different resource: broadcasts take a read lock and **never hold it across I/O**, and slow clients are dropped (per-client send buffer capped at 64) rather than being allowed to stall the broadcast goroutine.
- Tests that exercise concurrency must run under `-race`, and flakiness there is a real defect rather than an environment artifact.
