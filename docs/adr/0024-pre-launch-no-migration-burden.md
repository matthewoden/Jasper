# ADR-0024 — Pre-launch: no back-compat shims, no persistence migrations

**Status:** Accepted (expires at public launch)

## Context

Jasper has no users outside the project owner and a handful of coworkers, all of whom update deliberately. Every persisted client-side shape — tab state, pane layout, bookmarks, workspace settings — could in principle need a migration path when it changes.

Carrying that burden pre-launch means writing, testing, and maintaining migration code for shapes that no real user has ever persisted.

## Decision

While pre-launch: **restructure persisted client shapes freely.** No back-compat shims, no version fields, no migration functions. Rewrite call sites and test assertions outright rather than preserving old shapes behind a compatibility layer.

**This applies to derived and convenience state only.** It does **not** apply to notes on disk, which are sacred regardless of launch status ([ADR-0001](./0001-filesystem-is-the-source-of-truth.md)).

## What's in scope

Per-vault JSON stores, `localStorage` keys, persisted pane layouts and tab sets, the index schema (rebuildable by definition), and internal API shapes.

## What's out of scope

Anything under `notes/` — the markdown files, their frontmatter, and their attachments. A change that could corrupt or lose a `.md` file gets full care regardless of how few users exist. The vault is the product.

## Consequences

- Refactors that would otherwise need a migration are cheap. This has been used deliberately — the vault model reshape, for example, took one breaking change rather than maintaining two config layouts.
- A stale persisted shape may cause an error on first load after an update. Acceptable at this stage: clearing the key or the store fixes it, and the owner knows to expect it.
- **This ADR has an expiry.** At public launch it inverts, and every persisted shape needs a considered migration story. Anything relying on this should be findable when that happens — which is part of why it's written down rather than left as a shared assumption.

## Note

Config is a partial exception already: the loader is lenient across versions ([ADR-0020](./0020-config-lenient-read-strict-write.md)) because settings are annoying to lose and the leniency cost nothing. That was a judgment call about that specific surface, not a general retreat from this decision.
