# ADR-0009 — Bidirectional filename ↔ H1 binding

**Status:** Accepted 2026-05-03

## Context

Initially the file's name on disk and the note's first heading were independent. The file tree rendered the H1 as the row label.

UAT surfaced the consequence immediately: a user renamed a file and the tree label didn't change, because the label was showing the H1. The model was coherent and felt broken.

## Decision

The H1 *is* the displayed name and *is* the filename (without `.md`). They are one concept with two representations:

- Editing the H1 in the editor renames the file on disk.
- Renaming the file in the tree rewrites the H1 in the content.

There is no separate "filename" field exposed to the user anywhere in the UI.

## Rationale

Coupling them eliminates a whole class of confusion, matches the Obsidian convention users already carry ([ADR-0019](./0019-obsidian-as-default-ux-reference.md)), and unifies renaming into a single concept with a single surface.

## Consequences

- The server's `Move` operation accepts both triggers — a path rename and an H1 edit — and the `notes.Rewriter` walks the AST to rewrite frontmatter and the first H1.
- Programmatic edits to the document (the H1 rewrite, checkbox toggles, property writes) all inject through the same CodeMirror transaction path. New features that modify the document should extend that path rather than adding another.
- Concurrent H1 edit and tree rename resolve last-write-wins on canonical timestamp.
- Rename failures need a visible surface — a silent failure here looks like data loss.

## The generalizable lesson

This decision and [ADR-0008](./0008-vault-model.md) came from the same diagnostic move, recorded in the v1.0 retrospective:

> When a feature feels broken in UAT, look for an **asymmetry in the architecture** before adding documentation or polish. Symptom: "the user picked the same value in two places," or "the label says X but the file is named Y." Fix: collapse the two surfaces into one.
