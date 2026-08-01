# ADR-0028 — Migration resilience: three paths, backup-first, listener-last

**Status:** Accepted (foundational — v1.0, from `DESIGN.md` §4.4)

## Context

Schema migrations run at startup against a database the user cannot easily inspect or repair. A failed migration on a normal app means a support ticket. Here it must mean *nothing worse than a rebuild*, because [ADR-0001](./0001-filesystem-is-the-source-of-truth.md) says the index is reconstructible.

The mechanics are what turn that principle into an actual guarantee.

## Decision

**Backup first, then migrate.** On success, delete the backup. On failure, three explicit paths:

| Path | Action | Trigger |
|---|---|---|
| **1** | Atomic restore from the backup | Migration failed; backup is good |
| **2** | Drop derived tables and reindex from disk | User triggers "Reset and rebuild database" |
| **3** | Halt with a non-zero exit and serve a static error page | Neither of the above can proceed |

Supporting mechanics, each load-bearing:

- **Free-space precondition.** Before copying the backup, check for at least **2× the current database size**. Abort with a clear error rather than filling the disk mid-copy.
- **Atomic restore.** The Path 1 restore writes via temp + rename, so a crash mid-restore cannot leave a half-written database where the live one was.
- **The HTTP listener opens only after migrations and the incremental re-index complete.** A restart therefore never exposes a half-initialized server to a reconnect storm of waiting clients.
- **The drop list for Path 2 is derived from the embedded migrations**, not hardcoded.

## Rationale on the derived drop list

This one was learned the hard way. The drop list *was* hardcoded. A later migration added a table that nobody appended to it, so a rebuild re-ran that migration against a table that still existed, failed with "already exists," and fell through to Path 3 — turning the recovery mechanism into an unrecoverable halt.

Deriving the list by parsing `CREATE [VIRTUAL] TABLE` out of the embedded migrations, dropping in reverse migration order, and dropping `schema_migrations` last, means **adding migration N+1 can no longer silently reintroduce the failure**. The maintenance trap is structurally eliminated rather than documented.

## Consequences

- Startup is gated on migrations. The 5-second budget for a 5,000-note vault covers this plus reconcile.
- Path 3 is a genuine halt with a static error page, not a degraded mode. Serving a broken app is worse than serving an explanation.
- Path 2 is user-triggered from a migration banner, so recovery from a corrupt index never requires a terminal.
- A user with a nearly-full disk gets a clear pre-flight error rather than a corrupted database.

## The generalizable lesson

A recovery path that is only exercised during disasters will be broken when you need it. This one is exercised on every boot in its incremental form ([ADR-0012](./0012-incremental-reindex-on-startup.md)) and has dedicated tests for its drop-derivation. Recovery code needs the same test rigor as the happy path — arguably more, since nobody notices when it rots.
