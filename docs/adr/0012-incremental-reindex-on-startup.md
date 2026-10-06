# ADR-0012 — Incremental re-index on every startup

**Status:** Accepted. **Amended 2026-10-04:** a restored note keeps its id.

## Context

The index is derived ([ADR-0001](./0001-filesystem-is-the-source-of-truth.md)) and there is no filesystem watcher ([ADR-0011](./0011-manual-refresh-over-filesystem-watcher.md)). Something has to close the gap between what's on disk and what the index believes.

## Decision

Run an **incremental reconcile** on every startup — walk the filesystem, compare against the index, apply the delta. A full rebuild is available on demand via `POST /api/v1/admin/reindex` and a toolbar action.

Target: startup (migrations plus incremental re-index) under 5 seconds for fewer than 5,000 notes.

## Rationale

It's cheap, and it means every launch is a consistency checkpoint. External changes made while Jasper was closed — a git pull, a sync, a manual edit — are picked up without the user doing anything.

It also makes the derived-index guarantee concrete: the mechanism that recovers from a wiped database is the same one that runs on every boot, so it is continuously exercised rather than being an untested disaster-recovery path.

## Change detection is mtime-only

The original design specified **mtime-first with a checksum fallback** for ambiguous cases. The checksum half was deliberately deferred and has never shipped.

Rationale for the deferral: no real-world ambiguous-mtime case appeared across v1.0's development, and the fallback added meaningful complexity to the indexer. Revisit only if a genuine mtime collision surfaces — a file modified twice within the filesystem's timestamp granularity, such that the second edit is invisible to reconcile.

Worth knowing when diagnosing "my external edit didn't show up": the current answer is always mtime.

## Consequences

- Startup cost scales with vault size. The 5-second budget for 5,000 notes is the stated NFR; a regression past it is a real defect, not a tuning matter.
- Reconcile runs in a background goroutine and does not block the HTTP listener.
- A note restored by moving a file back into `notes/` **keeps the id its frontmatter carries**, and its tombstone is cleared, so a bookmark or persisted tab holding that id resolves again. (Amended 2026-10-04; until then identity lived only in the index and a restore minted a fresh UUID — see the amendment to [ADR-0032](./0032-bookmarks-carry-a-path-recovery-hint.md).) A rename made outside the app is likewise recognised as a move, not a delete and a create.
- Reconcile is no longer read-only on `notes/`: a note without a valid id line is given one, and nothing else in the file changes. Ids are settled across the whole pass before any row is written, so two files claiming one id never race each other into the index.
- The full rebuild path drops and recreates tables. That drop list is **derived from the embedded migrations** rather than hardcoded — a hardcoded list silently went stale when a migration added a table, and the rebuild then failed as unrecoverable. Adding migration N+1 must not be able to reintroduce that.
