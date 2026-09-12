# ADR-0032 — Bookmarks carry a path recovery hint, because note identity is not durable

**Status:** Accepted (v1.4)

## Context

[ADR-0001](./0001-filesystem-is-the-source-of-truth.md) says deleting `.jasper/app.db` is never data loss, because every derived surface rebuilds from the files on disk. That is true of metadata, FTS5, tags and backlinks. It is not true of **note identity**.

A note's UUID is minted by the indexer (`index.chooseID`) and persisted nowhere else — not in frontmatter, not in any sidecar. A full rebuild (`POST /api/v1/admin/reindex` with the default `mode: "full"`, which is also what the reset-and-rebuild recovery dialog calls) DROPs the notes table and re-mints every id.

`bookmarks.json` is **not** a derived surface. It is user-authored source-of-truth data, and it keyed off that UUID — its own package doc said "keyed by stable note UUID". So a full rebuild left every bookmark dangling, and prune-on-read dropped them all *and re-saved the pruned document*, writing the loss to disk. Reproduced: 4 bookmarks → 1, the survivor being the scratchpad, whose UUID is hardcoded.

The scratchpad surviving is the whole diagnosis in one observation. The prune was behaving exactly as designed; the defect was that identity churned underneath it.

## Decision

**Each bookmark row stores the note's canonical `path` alongside `noteId`, as a recovery hint.** On load:

1. `noteId` resolves → keep the row, and refresh the stored path if the note has moved.
2. `noteId` does not resolve, but the stored path does → **adopt the new id** and keep the row.
3. Neither resolves → prune, as before.

`noteId` remains the key. The hint is only consulted after the id has already failed.

## Rationale

Three alternatives were rejected:

- **Persist `id:` into frontmatter.** Makes identity genuinely durable and would fix anything ever keyed by UUID. Rejected because it writes Jasper's bookkeeping into every user `.md` file, diverges from the format Obsidian users expect ([ADR-0019](./0019-obsidian-as-default-ux-reference.md)), and contradicts what the reset dialog promises the user: "your `.md` files are not touched."
- **Preserve the path→UUID map across the rebuild** (read it before the DROP, re-seed after). Server-side and invisible, but it cannot help the case the rebuild exists for: a corrupt or wiped database has no map left to read. Bookmarks would still die in the only scenario the user reaches this through by accident.
- **Key bookmarks by path instead of UUID.** Sacrifices the property BOOK-04 ships — a bookmark surviving rename and move — to fix a rarer one.

The hint keeps the id as the primary key, so rename and move still work through it, while giving `Load` a second identity signal for the one case where ids are not trustworthy. It survives both a full reindex and a genuinely wiped database, because the hint lives in the same file as the bookmark.

Refreshing the hint on every successful resolve is load-bearing, not tidiness: without it, a note renamed after being bookmarked leaves a hint pointing at a path it no longer occupies, and the next rebuild resolves nothing. A rename would silently disarm the recovery.

## Consequences

- **A note occupying a deleted note's former path can inherit its bookmark.** Accepted: once the id is gone, the path is the only identity signal left, and this is what a path hint means. The window is narrow — prune-on-read removes a deleted note's bookmark at the next read, long before a path is typically reused.
- **A row written before the field existed has no hint and still prunes.** Pre-launch, so no migration ([ADR-0024](./0024-pre-launch-no-migration-burden.md)); such rows only exist in a vault predating this change.
- **`path` is deliberately absent from the wire type.** It is how storage recovers identity, not something a client should key off. `toWireBookmark` maps fields explicitly, so the storage shape can carry it without touching the OpenAPI contract.
- **`Registry.PathIndex()` builds a reverse map on demand** rather than maintaining a third index in lockstep with `byID` and `byTitle`. Only bookmark recovery calls it, and only after an id has already failed, so the common read pays nothing.
- **Note identity is still not durable.** This ADR makes bookmarks survive the churn; it does not stop the churn. Anything else keyed by note UUID that outlives a rebuild needs the same treatment or a real fix to identity. At the time of writing, bookmarks were the only such store — `workspace.json` holds sort and panel preferences only, and no note ids are persisted client-side.
- **ADR-0001 should be read with this caveat**: SQLite is disposable, but a value *minted* there and referenced from a source-of-truth document is not. "Derived" and "disposable" are not the same claim about identifiers as they are about indexes.

## Verification

`POST /admin/reindex` re-mints every note id and all bookmarks survive with adopted ids; a rename still keeps its bookmark; a deleted note's bookmark still prunes; and a rebuild *after* a rename still recovers, which is the case the hint refresh exists for. Covered by unit tests in `backend/internal/bookmarks/recovery_test.go` and E2E `BOOK-05` in `frontend/e2e/phase27-uat.spec.ts`, both proven to fail against the pre-fix prune loop.

`BOOK-04` covers a binary restart, which takes the *incremental* reconcile path and preserves ids — which is why it never caught this. The two paths need separate coverage.
