# ADR-0019 — Obsidian's behavior is the default for UI and UX

**Status:** Accepted (standing owner directive)

## Context

Jasper's users are Obsidian users who can't run Obsidian. They arrive with a full set of expectations about how a markdown notes app behaves — what Cmd+O does, where the breadcrumb sits, how tabs shrink, what a callout looks like.

## Decision

**When a UI or UX question has no strong project-specific reason to differ, do what Obsidian does.** This is the default, not a tiebreaker of last resort.

Applied instances:

- Filename ↔ H1 binding ([ADR-0009](./0009-filename-h1-binding.md))
- Vault model and vault picker ([ADR-0008](./0008-vault-model.md))
- Tabs: shrink-to-fit then overflow dropdown; breadcrumb above the page title, not inside the tab
- **Two distinct keyboard roles** — Cmd+O quick switcher, Cmd+P command palette, Cmd+K deliberately unbound
- Callout syntax `> [!type] Title`
- Split panes, drag-to-split, per-pane tab strips

## Rationale

Matching a mental model users already hold removes an entire category of friction at no design cost. Where Jasper deviates, the deviation should be *load-bearing* — traceable to the no-plugin posture, the filesystem-source-of-truth model, or a specific validated complaint — not incidental.

The Cmd+K case is instructive: a unified palette on Cmd+K was built and then removed, because two distinct roles match the mental model and one overloaded key doesn't.

## Consequences

- Design work is adjudicated against a concrete reference rather than argued from taste.
- For visual parity specifically, the gate is **owner side-by-side sign-off**, not automated assertions. A test asserting a font on the editor root passed while every line of prose rendered monospace — it measured the wrong node. Automated checks guard regressions; they don't define "matches."
- **For UI-heavy work, code-verified is not owner-accepted.** One phase passed all 22 of its criteria on day one and still needed five hands-on UAT rounds; a verified decision was reverted in use. The subjective-feel tail is real and no automated gate shortens it — budget for it.
- Behavioral UAT must include **mouse gestures**, not just keyboard. The most stubborn bug in that phase lived on a click-only path that keyboard-driven E2E structurally cannot reach.

## Theming is fixed, not user-extensible

Jasper ships **one dark palette plus four accent colors** (purple default, sky, green, orange). Arbitrary theming, custom token editing, and saved theme presets are out of scope.

This isn't only a scoping call — a user-supplied styling layer is an injection point, and it's why `cssclasses`-style per-note CSS hooks are also excluded ([ADR-0002](./0002-no-plugin-surface.md)). The light theme exists but was not re-tokened during the dark redesign.

## Boundary

This governs *feel*, not *architecture*. Obsidian's plugin ecosystem is precisely what Jasper rejects ([ADR-0002](./0002-no-plugin-surface.md)), and its wiki-link path syntax is deliberately not adopted ([ADR-0010](./0010-title-only-wiki-links.md)).
