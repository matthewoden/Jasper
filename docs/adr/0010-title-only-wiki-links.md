# ADR-0010 — Wiki-links are title-only; no path syntax

**Status:** Accepted

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
