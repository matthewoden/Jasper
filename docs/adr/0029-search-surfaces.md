# ADR-0029 — Search lives in the palette and in a dedicated panel, never as a tree filter

**Status:** Accepted 2026-05-14 (palette pivot) · extended 2026-07-04 (sidebar panel)

## Context

Search was originally specified as a **sidebar input that filtered the file tree** — type a query, the tree narrows to matching notes.

It never landed cleanly. The tree is a hierarchy with expansion state and a selection model; search results are a flat, ranked list. Making one surface serve both meant the tree was constantly switching between two incompatible mental models, and the result felt wrong in a way that repeated polish didn't fix.

## Decision

Search is **not** a tree filter. It has two surfaces, both flat and ranked:

1. **The Cmd+P command palette** — FTS5-backed results with snippet previews, alongside commands. The primary surface, and the pivot that made search feel native.
2. **A dedicated in-sidebar Search panel** — added later, with a `tag:` tokenizer and multi-tag AND. It **coexists with** the palette; it does not replace it, and it is not the tree.

The file tree stays a file tree.

Note the related but distinct role split: Cmd+O is the quick switcher (fuzzy over titles), Cmd+P is the command palette (which includes full-text results). See [ADR-0019](./0019-obsidian-as-default-ux-reference.md).

## Rationale

The failure was structural rather than cosmetic. A filtered tree has to answer questions it has no good answer for: does a matching note show its non-matching ancestors? Does expansion state survive a query? What does selection mean when the visible set is a projection? Each answer is defensible and the combination never feels right.

A flat ranked list has none of those problems, and it's the shape every user already expects from search.

## Consequences

- The tag browser retains a genuine filter-the-tree interaction — that's different, because a tag filter is a *set membership* question with stable results, not a ranked relevance query.
- Adding a second search entry point later was cheap precisely because the first one didn't own the tree. Both call the same `/search` backend.
- Search result **sorting** is a real SQL `ORDER BY` (relevance / modified / created), not a client-side re-sort of a fetched page.

## The generalizable lesson

Recorded in the v1.0 retrospective and applicable well beyond search:

> When a feature feels broken in UAT, look for an **architectural mismatch** before adding polish.

This pivot, the vault model ([ADR-0008](./0008-vault-model.md)), and the filename↔H1 binding ([ADR-0009](./0009-filename-h1-binding.md)) were all found by the same move — and all three were reached only after polish had already been attempted and failed.
