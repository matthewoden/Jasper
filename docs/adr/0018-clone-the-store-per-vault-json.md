# ADR-0018 — Per-vault UI state lives in dedicated JSON stores, cloned from one proven shape

**Status:** Accepted

## Context

Several features need per-vault state that isn't note content: bookmarks, sort orders, right-panel selection, pane layout. It's not user-authored prose, so it doesn't belong in `notes/`; it's not derived, so it doesn't belong in the index ([ADR-0001](./0001-filesystem-is-the-source-of-truth.md)).

## Decision

Each such concern gets its own JSON file under `<vault>/.jasper/` — `bookmarks.json`, `workspace.json`, and so on — and each is a **structural clone of the same store shape**:

- atomic write (same primitive as note writes)
- registry validation on load
- a `*:changed` WebSocket event on mutation
- an optimistic client hook mirroring the established pattern
- **lenient decode** — unknown fields are preserved, never a cause of reset

Anything that references a note does so **by UUID**, so it survives rename and move.

## Rationale

Cloning one proven shape across five surfaces landed them consistent and low-risk, instead of five bespoke designs each with its own bugs. The store shape had already been through review and hardening once; the clones inherited that.

## Consequences

- **Lenient decode is not optional.** The config loader originally used a strict decoder (`DisallowUnknownFields`) that fell back to defaults on any unrecognized key — so a newer binary's field, or one hand-edited key, silently wiped the user's settings. A code review caught that same wipe risk being cloned into a new store before it shipped. Every store in this family must accept unknown fields and preserve them.
- UUID-keying is what makes bookmarks survive a rename. A path-keyed store would break on the most ordinary operation in the app.
- Losing one of these files degrades convenience, not content — consistent with keeping note data in `notes/` and nowhere else.
- These stores are per-vault, so hot-swap tears them down and reopens them with the rest of the vault's subsystems ([ADR-0008](./0008-vault-model.md)).

## This pattern won, and the config loader adopted it

For a long time the config loader was the holdout — it kept the strict decoder while these stores used lenient decode, and the gap was papered over per-field with `omitempty` plus a "kept for legacy parse" comment. That doesn't scale; a milestone adding six fields at once forced the issue.

The loader was subsequently rewritten to per-field leniency, explicitly citing the pattern proven here. See [ADR-0020](./0020-config-lenient-read-strict-write.md).
