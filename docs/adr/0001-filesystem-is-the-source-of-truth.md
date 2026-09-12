# ADR-0001 — The filesystem is the source of truth; SQLite is derived

**Status:** Accepted (foundational, locked pre-implementation in `DESIGN.md`)

## Context

Jasper needs fast full-text search, tag and backlink queries, and a file tree that stays responsive past 1,000 notes. All of that wants an index. The obvious shape is a database that owns the notes, with files exported alongside.

But the product promise is *full local ownership of the underlying files*. A user must be able to point Syncthing, git, or another markdown editor at the vault and have it work — and must be able to recover everything if Jasper itself fails.

## Decision

The `notes/` directory of `.md` files is the sole source of truth. SQLite is a fully derived, disposable index.

Concretely:

- Deleting `.jasper/app.db` is never data loss. Reconcile rebuilds every derived surface — metadata, FTS5, tags, backlinks — from the files on disk.
  - With one caveat that has already cost a defect: a note's **UUID** is minted in SQLite and stored nowhere else, so a rebuild re-mints it. Anything outside the index that references a note by id is therefore referencing a value this ADR makes disposable. See [ADR-0032](./0032-bookmarks-carry-a-path-recovery-hint.md).
- No user-authored content exists only in SQLite. Tags live in the note body; properties live in the note's frontmatter; note content is the file.
- Nothing outside the `index` package queries SQLite directly.

## Consequences

**This is what makes the rest of the architecture possible.**

- The migration runner can offer a **three-path** strategy: apply migrations; roll back and restore a backup; or, in the worst case, wipe the database entirely and rebuild from disk. Path 3 is only survivable because of this decision.
- External edits (another editor, a sync client, a git checkout) are legitimate and recoverable. Reconcile adopts them.
- A restored file — dragged back out of `.trash/` in Finder, say — is re-adopted by the reconciler with a fresh UUID. No in-app restore machinery is needed. See [ADR-0015](./0015-filesystem-native-soft-delete.md).
- Corruption in the index is an inconvenience, never a catastrophe.

**Costs, accepted:**

- Every write pays filesystem cost first, then index cost. See [ADR-0007](./0007-file-first-save-path.md).
- Startup pays an incremental reconcile. See [ADR-0012](./0012-incremental-reindex-on-startup.md).
- Any feature that wants to store user data *only* in SQLite is, by definition, wrong. This has bitten before and will again — the check is always "could we delete the database and lose this?"

## Related

- Per-vault UI state ([ADR-0018](./0018-clone-the-store-per-vault-json.md)) is a deliberate, bounded exception: it lives in JSON files inside `.jasper/`, not in SQLite, and losing it degrades convenience rather than content.
