# ADR-0010 — Wiki-links are title-only; no path syntax

**Status:** Accepted. **Amended 2026-10-04:** a second link form, `[[ns:kind/id]]`, for references.

## Context

Obsidian supports both `[[Title]]` and `[[path/to/note]]`. Supporting paths makes link resolution unambiguous at the cost of putting folder structure into prose.

## Decision

Support `[[Title]]` and `[[Title|Alias]]` only. Path syntax `[[path/to/note]]` is deliberately not supported.

Ambiguity — two notes with the same title — resolves **same folder first, then alphabetically**.

## Rationale

Title-based resolution is friendlier to write and read. Path syntax exposes folder structure inside note bodies and creates rigid link breakage the moment a note moves — which is exactly the operation the file tree makes easy.

The same-folder-then-alphabetical rule is predictable, requires no disambiguation UI, and matches what an author locally intends: a link written next to its target usually means that target.

## Consequences

- Renaming a note rewrites every `[[link]]` to it across the vault. This is a real write fan-out and needs a visible failure surface — a partial rewrite is worse than a refused one.
- Moving a note never breaks its inbound links, because links don't encode location.
- Two notes with the same title in different folders are resolvable but not addressable independently from prose. Accepted; the alternative reintroduces paths.
- Autocomplete offers titles, not paths.

## Note

If auto-pair brackets are ever added to the editor, `[[` needs explicit handling — stock bracket-closing doesn't know `[[wiki-link]]` is one construct rather than two `[` characters, and it will fight the autocomplete's own insertion.

## Amendment (2026-10-04) — references are a second grammar, not a path

`[[...]]` now carries two kinds of target. A **title** resolves as above. A **reference** follows the grammar `ns:kind/id` (`[[ado:workitem/12345]]`, `[[jasper:note/01ARZ…]]`, `[[jasper:blob/sha256-…|shot.png]]`), with `file:` as the one prefix that carries no kind. A reference is stored as written and resolves nowhere inside Jasper unless its namespace is `jasper:`; what it names in another system is that system's business.

The two cannot collide: a note title can never contain `/` (`validateBareName`), and the grammar requires one. Path syntax stays unsupported, and `[[path/to/note]]` is now simply an invalid reference rather than an unsupported path. `#fragment` belongs to the reference when the target is one, since a foreign id may contain `#`; for a title it is split off as before.

Every link, title or reference, lands in the `refs` table in its universal form: a resolved title as `jasper:note/<id>`, an unresolved one as `jasper:title/<title>`. Backlinks for any target, foreign included, are one lookup on that table; the linked-mentions panel keeps reading `backlinks`, which holds the excerpts. Both are written from one walk in one transaction.

Consequences:

- A note can hold `[[ado:workitem/12345]]` and the index answers "who references this work item" without knowing what a work item is.
- `[[jasper:note/<id>]]` survives a rename of its target without a rewrite; `[[Title]]` still gets one.
- The editor renders a reference as a chip rather than as a pending title, so an author never sees a foreign id offered as a note to create.
