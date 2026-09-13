# ADR-0033 — Boot refuses to serve when the registry cannot hydrate

**Status:** Accepted (v1.4)

## Context

The registry is the UUID → relative-path map (`notes.Registry`), hydrated once at boot from `indexer.List`. Until now a failed `List` was a warning:

```go
} else {
    a.cfg.Logger.Warn("registry hydrate: List failed (proceeding with empty registry)", "err", err)
}
```

Boot then continued, and the server came up **reporting `"state":"ok"`** with an empty registry. In that state nothing resolves by UUID: persisted tabs, bookmarks and deep links all fail to open, and wiki-links and backlinks have nothing to resolve against. The user sees an apparently empty vault while every `.md` file sits untouched on disk.

That is the exact failure [ADR-0001](./0001-filesystem-is-the-source-of-truth.md) exists to make impossible-looking. Warn-and-proceed converted a recoverable, loud failure into a silent one that is indistinguishable from data loss — and it was the one boot step that did so. Every sibling step (file logger, data dir, scratchpad seed, storage dir, disk preflight, sqlite open, migration, frontmatter scaffold) already fails into `serveStartupError`.

`List` fails in two distinguishable classes:

- **Transient** — `SQLITE_BUSY` / locked, under parallel filesystem load. Clears on its own. This is the class that surfaced as a flaky boot test finding zero notes where it had seeded a scratchpad, which is how the defect stayed filed as a test problem rather than a boot problem.
- **Permanent** — a missing table, a schema mismatch, or a single unparseable id. Does not clear.

## Decision

**Retry a bounded number of times, then refuse to serve.**

1. `hydrateList` attempts `List` up to 3 times, backing off 50ms then 100ms — 150ms worst case, against a <5s startup budget.
2. On exhaustion, boot returns `serveStartupError(ctx, "Registry hydrate", …)`, the same path every other boot step uses: a 503 page naming the phase, the error, a suggested action, and a log excerpt.
3. `Indexer.List` **skips** a row whose id will not parse, counts it, and warns — rather than failing the whole call.
4. The suggested action for this phase names a **rebuild**, not a restore: *"Stop Jasper, delete `.jasper/app.db`, and restart to rebuild the index."*

Point 4 is not cosmetic. `suggestedActionFor` previously fell through to "Restore from your most recent backup" for any error it did not recognise, which for a derived index is both alarming and wrong — it invites the user to restore files that were never damaged. `jasper doctor` is diagnostic and cannot rebuild, so it would have been equally wrong to name.

## Rationale

Three alternatives were rejected:

- **Fail fast with no retry.** Simplest, and exactly consistent with the sibling steps. Rejected because the failure actually being observed is the transient class: a momentary lock under load would become a hard boot failure, trading a silent wrong state for a loud wrong state. A bounded retry costs 150ms in the worst case and nothing in the common one.
- **Boot degraded, and name it in the UI** via the existing `api.BootBanner` machinery. Keeps the server reachable, which is attractive for a self-hosted app with no operator. Rejected because the user still faces an empty vault; a banner explaining it does not make the notes reachable, and the screen that looks like data loss is the thing to avoid, not to caption.
- **Keep warn-and-proceed, and fix the flaky test instead.** This is what the ticket's original framing invited. Rejected: the test was correct to notice, and the index being derived is an argument for rebuilding it cheaply, not for serving a vault that appears empty.

Retrying in production boot code is not the retry loop [`CONVENTIONS.md`](../../CONVENTIONS.md) forbids. That rule bans retries added to a *test* to paper over a flake. Here the retry is in the code under test, it is bounded, and exhaustion is a hard failure — the transient is handled, not hidden.

## Consequences

- **The boot contract changed: Jasper can now refuse to start where it previously started.** A permanently unreadable index is a hard stop. Accepted, because the alternative state was actively misleading, and the error page names a remedy that works.
- **A corrupt index now blocks access to the whole vault until the user acts.** Mitigated by point 3 — the common corruption (one bad row) no longer trips this at all — and by the remedy being a single file deletion that ADR-0001 guarantees is safe. But it is a real cost: a user who cannot read the error page (a headless install, a service that fails on boot) sees a server that will not come up, where before it came up wrong. `jasper status` and the log both name the phase.
- **Skipping unreadable rows means a note can silently drop out of the registry.** It is logged with a count and a "reindex to repair" hint, and the file is still on disk, but the note is unreachable by UUID until a reindex re-mints its id. This is the same all-or-nothing trade JASPER-33 raises for the reconcile walk; the choice here is deliberately the tolerant one, because the alternative is losing the other 999 notes.
- **Startup gains up to 150ms on a path that currently never fires.** Inside the NFR, and only when `List` is already failing.
- Scan errors and `rows.Err` remain fatal. They indicate schema-level drift rather than one bad row, and a partial registry built on a misread schema is worse than a refusal.
