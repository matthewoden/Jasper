# ADR-0015 — Soft-delete is filesystem-native

**Status:** Accepted

## Context

Deleting a note should be recoverable. The conventional answer is a Trash UI: a browsable list of deleted items, a restore command, an "empty trash" action.

## Decision

Delete moves the note or folder to `.trash/` inside the vault, with collision-safe naming. `.trash/` is excluded from every index surface — tree, search, tags, backlinks, MCP tools.

**There is no in-app restore command, no empty-trash palette action, and no Trash browser UI.** Restore is moving the file back in the OS file manager and hitting Refresh.

## Rationale

The filesystem is already the source of truth ([ADR-0001](./0001-filesystem-is-the-source-of-truth.md)), and the reconciler already adopts files that appear in `notes/`. So restore is *already implemented* — by Finder, by Explorer, by `mv`. An in-app trash browser would duplicate the OS file manager without adding safety.

Keeping the delete path filesystem-native also keeps it inspectable: a user who wants to know what was deleted can look, with tools they already have.

## Consequences

- A restored note is re-adopted with a **fresh UUID**. References held by UUID — bookmarks, persisted tabs — will not resolve to it. Accepted.
- `.trash/` exclusion has to be honored by every surface that walks the vault. When a new index surface is added, exclusion is part of the work, not a follow-up.
- The vault grows until the user empties `.trash/` themselves. This is visible and manageable with ordinary tools.
- The pattern generalizes: `.trash/` exclusion is the established mechanism for "files in the vault that aren't ordinary notes." Reuse it rather than inventing a second exclusion mechanism.

## Related scope decision

Template files were explicitly **not** given `.trash/`-style exclusion — for the current milestone, template files are ordinary notes and do appear in search, tags, and MCP listings. That was a deliberate owner call, not an oversight.

## Amendment note — MCP makes a delete less visible (2026-08-22)

Recorded during triage of the durability audit, which argued for an in-app trash browser with restore and retention. **The decision above stands** — nothing here reopens it.

What is genuinely new since this ADR was written is that a delete no longer has to come from the user. A confused MCP client, or a misclick in a tool driving `delete_note`, removes a note without the user watching it happen. Recovery still works — the file is in `.trash/` and moving it back re-adopts it — but it depends on the user knowing `.trash/` exists, and an AI-triggered delete gives them no moment where they would have learned that.

That is a stronger argument than the one this ADR weighed, which assumed a user who had just chosen to delete something. It is grounds to reopen if it bites in practice. It is not, on its own, grounds to build the trash browser this ADR declined.
