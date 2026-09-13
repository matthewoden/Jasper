# ADR-0034 — Attachments travel with a moved note; references are not rewritten

**Status:** Accepted (v1.4)

## Context

An attachment reference is written into a note **folder-relative** — `![pic.png](attachments/pic.png)` — from the upload response's `path`. It is *resolved* by a completely different rule: the editor's inline-image widget strips the prefix and requests `/api/v1/attachments/{noteId}/{bare-filename}`, and the server recomputes the directory from the note's **current** path (`attachmentsRelDir` = the note's parent + `/attachments`).

The two anchorings agree only while the note stays put. Move a note between folders and the server looks for its attachments under the destination folder, where they were never written. Every image the note embeds silently stops rendering — no error, no banner, no log line. Reproduced end-to-end: `GET` the attachment before the move returns 200, after returns 404, the file still on disk in the source folder and the note's markdown unchanged.

Only single-note moves are affected. `MoveFolder` is a wholesale `MoveDir`, so a folder move carries its `attachments/` subdirectory with it, and an in-place rename never changes the parent.

The complication is that **`attachments/` belongs to a folder, not to a note** — every note in a folder shares one directory. So the directory cannot simply follow a note out of its folder; a sibling left behind may reference the same file.

## Decision

**On a move that changes a note's folder, the attachments it references move with it, and the reference text is left alone.**

For each `attachments/…` reference the note holds:

1. Missing at the source → skip. It was already dangling; relocating nothing is honest.
2. Still referenced by another note in the source folder → **copy**, so the sibling keeps rendering.
3. Otherwise → **move**.
4. Destination name already taken → the incoming file takes a `-N` suffix and **that one reference is rewritten** in the moved note.

This lives in `notes.Service.Move`, not in the move handler, so an MCP `move_note` gets it too — REST and MCP are independent listeners into one Service. Every completed file operation is undone if a later one fails, so the move stays all-or-nothing.

## Rationale

Rewriting the references instead — the obvious first instinct — **cannot work here.** The serving route accepts a bare filename, so there is no text that would resolve: `../old/attachments/x.png` matches neither the widget's regex nor anything the route can express. Making arbitrary relative paths resolvable would be an OpenAPI contract change plus a path-traversal review of an already-hardened route, and it would leave the vault full of `../../` chains that grow every time a note is reorganized.

Three alternatives were rejected:

- **Resolve attachments by name, vault-wide** — the Obsidian default. Obsidian writes `![[Figure 1.png]]` with "shortest path when possible", so its embeds encode no location and a move cannot break them. This is the same trick [ADR-0010](./0010-title-only-wiki-links.md) plays for note links, and it is genuinely tempting for consistency. Rejected because an attachment is not a note: a name-resolved embed only renders inside Jasper. The most-installed Obsidian plugin in this space exists to undo exactly that property, and its rationale is a direct hit on why Jasper exists — a vault can be "perfectly navigable inside it and full of dead links the moment you open a note anywhere else — in another editor, published to GitHub, or exported as a folder." `attachments/pic.png` next to the note is a real relative path that renders in any markdown tool. That portability is the product.
- **Change the serving route to resolve relative paths, then rewrite on move** (the Obsidian-parity-shaped option). Rejected on cost and on the `../` chains above — and the parity was illusory: Obsidian does **not** do this. In relative-path mode, moving the note that *contains* a relative link does not update it. An Obsidian moderator acknowledged it, called it "a whole new system," retagged it down from high priority, and it went unfixed for years.
- **Refuse the move with a 409 when an attachment name collides.** Consistent with how case collisions are handled, and it never surprises anyone's files. Rejected because blocking a legitimate reorganization over an incidental filename clash is worse UX than a `-N` suffix, and the suffix is already how the upload path handles the same clash.

Copying rather than moving a shared attachment duplicates bytes. Accepted deliberately: a duplicated file is recoverable, a sibling whose image vanished is not. The same bias applies when the index list is unavailable — every reference is then treated as shared.

## Consequences

- **Attachments no longer accumulate in the folder a note was first created in.** They follow the note. This is a behavior change for anyone who was relying on `attachments/` as a per-folder library; nothing in Jasper presented it that way, but nothing prevented it either.
- **Bytes are duplicated when two notes in a folder embed the same file and one moves.** There is no reference counting and no later deduplication. A vault where many notes share attachments and get reorganized often will grow.
- **A `-N` rename rewrites the moved note's body.** `note:moved` only invalidates the tree, so the move also broadcasts `note:updated` to drive content reconciliation in other sessions. The session that *initiated* the move is excluded from broadcasts by SYNC-03 and keeps stale text until it refetches; its next save would write the pre-rename reference back and re-break the embed. The existing wiki-link rewrite-on-rename path has the identical gap. Narrow — it needs a genuine filename collision in the destination — but real, and not fixed here.
- **Only the `attachments/` prefix is recognised.** A hand-authored `![x](../elsewhere/pic.png)` is not relocated. Nothing in Jasper produces one.
- **References are percent-encoded at insertion**, so a filename with a space is a legal CommonMark destination and relocates like any other. Before that, the editor's widgets matched such references with a regex and rendered them while no other markdown tool would, and the extractor — a goldmark AST walk — could not see them at all. Encoding at insertion is what makes the AST walk sufficient. The extractor therefore carries both forms: `Raw` is the text in the note, `Path` is it decoded. Filesystem work uses `Path`; the `-N` rewrite must key on `Raw`, or the substitution finds nothing and leaves the note pointing at the occupant's name. See [ADR-0035](./0035-attachment-references-are-percent-encoded.md).
- **The relocation reads every sibling note in the source folder** to decide move-vs-copy. Bounded to one folder, on an operation a human performs by hand.
- **`CONTEXT.md`'s Attachment glossary entry was wrong** — it described the directory as per-note, which is precisely what makes "just move the directory with the note" sound safe. Corrected alongside this change.

## Verification

Regression tests in `backend/internal/api/attachments_move_test.go` cover the reproduction (200 before, 200 after, file at the destination, reference text untouched), the shared-sibling copy, the colliding-name rename with the occupant left intact, and an in-place rename touching nothing. The first three were proven to fail with the relocation call disabled. Unit tests in `backend/internal/notes/attachments_test.go` cover undo-on-failure against an in-memory store that fails one specific `MoveFile`, plus move-vs-copy selection and the already-dangling skip; `backend/internal/markdown/attachments_test.go` covers extraction, including code fences, frontmatter and percent-decoding.
