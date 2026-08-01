# ADR-0023 — `internal/markdown` is a leaf package and stays dependency-free

**Status:** Accepted (enforced by the import graph)

## Context

`internal/index` imports `internal/notes` for the note record type. So if `internal/markdown` imported either of them, the graph would cycle.

Markdown parsing is needed by both: `notes.Service` calls it to extract titles, tags, and links on every write; the indexer calls it during reconcile.

## Decision

`internal/markdown` is a **leaf package**. It imports neither `internal/notes` nor `internal/index`, and it never will. Both of those call *into* it.

New parsing or content-rewriting capability goes in `internal/markdown` as a **sibling file**, or in an equally leaf-level new package — never inside `internal/notes`.

## Rationale

Beyond avoiding the cycle, this keeps content transformation independently testable: `markdown` functions take bytes and return bytes, with no service, no database, and no filesystem.

The existing shape demonstrates it — `ExtractTitle`, `ExtractTags`, `ExtractBodyTags`, `RewriteFrontmatterTags` are all pure content functions, and `RewriteFrontmatterTags` in particular does structure-preserving YAML mutation through a node API rather than string surgery.

## Consequences

- **One implementation, many callers.** `RewriteFrontmatterTags` is called by both Create and Update; `ExtractTitle` by Update, Create, and Move. New content transforms should follow the same discipline rather than being duplicated per call site.
- New content features extend this family: frontmatter properties belong beside tags, template substitution belongs in its own leaf package. Neither belongs in `notes.Service`.
- **Never duplicate a content transform in TypeScript.** If a client-anchored flow needs a server-side transform, fetch the result rather than reimplementing it — two implementations of date formatting or variable substitution will drift.
- `notes.Service` stays the orchestrator: it calls markdown helpers and owns the write ordering ([ADR-0007](./0007-file-first-save-path.md)). It does not itself parse.

## Related routing constraint

A separate ordering rule lives in the composition root and is equally load-bearing: in `app.go`, **the SPA fallback `r.Mount("/", …)` must be mounted last**. Anything mounted after it is unreachable — the catch-all swallows the request and serves `index.html` with a 200, producing "it opens the app instead of the thing I asked for" rather than a loud 404. Any new route tree needs an explicit mount before that line and a route-order regression test.
