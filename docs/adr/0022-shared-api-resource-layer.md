# ADR-0022 — Shared API resource layer: fetch-once and cache by default

**Status:** Accepted 2026-07-31

## Context

Measured: a 3-note vault with 4 tree rows issued **35** `GET /mcp/grants` in a trivial session, against **2** `GET /tree` on the same render.

The cause is structural, not a bug in one component. `TreeRow` is `react-arborist`'s per-row renderer and calls `useMcpGrants()`; every `GET /tree` remounts every row, and each mount fires its own fetch. The house pattern — module-subscriber Set plus fetch-on-mount — *is* the defect. `/tree` was fine only because it had a hand-rolled coalescer that `/mcp/grants` didn't.

`useFileTree`'s own doc comment had predicted this: adding a subscriber per non-display caller "inflates the broadcast Set by N … which collapses the single-flight coalescer."

## Decision

A GET endpoint is fetched **once** and shared by every consumer. **A component mounting is never, by itself, a reason for a network request.**

- **In-house `createResource` / `useResource`**, not TanStack Query — adopting it would reopen the locked stack decision in `DESIGN.md` §2, which specifies zustand and excludes it.
- **Coalescing is unconditional; caching is per-resource.** Every request enters an in-flight registry keyed by **endpoint + params**. An uncached ("pass-through") resource still issues exactly one call under a cold bulk invocation — opting out of caching never means escaping the pattern.
- **Reads join in-flight; invalidations never join.** A read has no "since" — it wants whatever is current. An invalidation does: a WebSocket event said data changed at time T, so a request issued before T cannot be trusted, and `invalidate()` starts a fetch strictly *after* the current one resolves.
- **Resources declare their invalidating events** at registration: `createResource(key, fetcher, { invalidatedBy: ['mcp:grant_changed'] })`. One event, one invalidate, one refetch — structurally.
- **Subscription is `useSyncExternalStore`.** Reading is a render-time snapshot rather than an effect, so subscribing *structurally cannot* trigger a fetch. Also immune to StrictMode double-invocation, which is live at all three mount points.
- **Enforcement is structural first, lint second.** Raw GET fetchers are module-private, so there is nothing for a component to import and call; a `no-restricted-imports` rule is the backstop, shipping at `error` severity in pre-commit and CI, with **zero exemptions**.

## Note bodies are never cached

`/notes/{id}` and `/notes/by-path` are pass-through. This is a **data-integrity** decision, not a performance one.

Several call sites exist specifically to obtain server truth — resolving a save conflict, fetching explicitly-named `fresh` content, rewriting the H1 after a rename. Note bodies also carry `If-Match` optimistic locking ([ADR-0007](./0007-file-first-save-path.md)). Handing any of those a cached body is a **lost-write bug**, not a stale-render bug.

Rejected: caching with per-site bypass (eight sites each needing individual audit; one wrong call loses user writing) and uniform caching trusting `note:updated` (puts the file-first contract behind a cache-coherence assumption). Note content's real cache is the editor buffer, which already exists ([ADR-0016](./0016-shared-document-single-writer.md)).

## Consequences

- The layer owns server data; `useTreeStore` becomes client-UI-state-only.
- **Vault hot-swap must hard-clear the entire cache.** Every entry is vault-scoped; without a flush, a swapped-in vault renders the previous vault's tags, grants, bookmarks, and backlinks. This attaches to the ordered teardown in [ADR-0008](./0008-vault-model.md).
- Anything that *can* change during a session gets an `invalidatedBy` entry or is not cached at all. "Boot-scoped" is a stated claim per resource, so an omission reads as a bug rather than as silence — a classification made on that basis was already corrected during planning when `/vault/about` turned out to carry live counts.
- A **standing request-count budget** in Playwright is part of the decision, not a nice-to-have: the lint gate catches a new raw call but cannot catch a new mount effect. Only a request-count assertion closes the whole defect class.
- Rejected: stale-while-revalidate on a TTL — it reintroduces timed per-mount fetches, a softer form of what this exists to remove.

## Scope note

This landed for the **read** path only. The mutation call sites keep their existing exports; the write half is deliberately booked as a follow-on, and no defect has been measured there — it's consistency work, not a bug fix.
