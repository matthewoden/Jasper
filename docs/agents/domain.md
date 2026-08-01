# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a single-context repo:

```
/
├── CONTEXT.md                  ← vocabulary + invariants
├── CONVENTIONS.md              ← process rules
├── docs/adr/
│   ├── README.md               ← index, and the precedence rule
│   ├── 0001-filesystem-is-the-source-of-truth.md
│   └── …                       ← 29 and counting
├── backend/
└── frontend/
```

For reference, a multi-context repo (signalled by a `CONTEXT-MAP.md` at the root) looks like:

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_

## The decision record is `docs/adr/`, and it is complete

This project shipped four milestones under a planning system whose artifacts have since been removed. Their durable content was mined into `docs/adr/` first — **so `docs/adr/` is the record, not a partial view of one.** If a decision isn't there, it wasn't recorded, not "recorded elsewhere."

Two caveats worth knowing:

- **`DESIGN.md`** at the repo root is the pre-implementation architectural reference, authored before the project began. It is still accurate about the locked architectural shape and is cited by several ADRs. It is *not* a decision log.
- **Numbers are identifiers, not precedence.** Read [`docs/adr/README.md`](../adr/README.md) before adding or amending — a decision that evolves amends its existing ADR rather than getting a new number, so an older release can't outrank a newer decision by numbering.

Historical planning artifacts remain retrievable from git history if you ever need the execution record behind a decision.
