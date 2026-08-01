# ADR-0026 — Canonicalize paths to NFC + lowercase; reject case collisions

**Status:** Accepted (foundational — v1.0)

## Context

Jasper targets macOS and WSL2, whose filesystems disagree about what counts as the same filename:

- **macOS APFS** is case-insensitive (by default) and historically normalizes Unicode toward NFD.
- **Linux/WSL2 ext4** is case-sensitive and stores whatever bytes it's given.

So `Meeting Notes.md` and `meeting notes.md` are one file on a Mac and two on Linux. And a filename containing an accented character can be byte-different between the two while looking identical, which breaks index lookups and wiki-link resolution in ways that are very hard to diagnose.

## Decision

1. **Every path is canonicalized to NFC + lowercase** before any read, any write, or any index lookup.
2. **Creating a file whose canonical path collides case-insensitively with an existing one is rejected** — `ErrCaseCollision`, mapped to 409 Conflict.

The canonical form is the lookup key. The on-disk name preserves the user's chosen casing for display.

## Rationale

Choosing the *stricter* of the two platforms as the rule means a vault created on either one behaves identically on the other. Allowing case-distinct siblings would produce vaults that silently merge files when synced to a Mac — data loss with no error.

NFC over NFD because it's the interchange norm (and what most tooling emits); the important part is picking one and applying it everywhere, not which one.

## Consequences

- A user cannot have `README.md` and `readme.md` in the same folder. Correct — they'd collide on macOS anyway.
- Canonicalization must happen at **every** boundary: HTTP handlers, MCP tools, the reconciler, wiki-link resolution. A path that skips it becomes an index entry that can never be found again.
- Wiki-link resolution is case-insensitive after canonicalization, which is why `[[meeting notes]]` finds `Meeting Notes.md` ([ADR-0010](./0010-title-only-wiki-links.md)).
- Vault paths themselves carry an ASCII + NFC constraint from the same reasoning.
- Bookmark folder names are **not** subject to this — they're virtual labels, not filesystem paths, so they get case-insensitive uniqueness without the filesystem-legal-character restriction.

## Related validation

Path handling also rejects `..` traversal, absolute paths, symlink escapes, and anything resolving outside the vault's `notes/` prefix. Those are separate checks in `fsstore` with their own sentinel errors, all mapped to 400.
