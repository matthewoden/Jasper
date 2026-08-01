# Issue tracker: Local Markdown

Issues and specs (you may know a spec as a PRD) for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` — never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

## What's in `.scratch/` today

```
.scratch/
├── audit-findings/              ← the non-security audit remainder, triaged
├── flaky-tests/                 ← three known instances, two are production defects
├── v1.4-properties-templates-settings/   ← six remaining phases of the current milestone
├── bookmarks-sorting-and-menus/ ← specified, ready to build
└── backlog/                     ← unbuilt ideas with no committed home yet
```

`backlog/` is the one departure from the one-directory-per-feature rule: single files for work that has been deferred repeatedly and isn't specified enough to warrant a spec plus issues. Promote a file into its own directory when it gets scoped.

## Retiring a finished effort

**Delete the directory once the work ships.** Tickets and specs are a queue, not a
record — they must never become the source of truth for a decision that was made.

Before deleting, move anything durable to where it actually belongs:

| What | Where it goes |
| --- | --- |
| A decision, and the alternatives rejected | an ADR in `docs/adr/` |
| A rule about how we work | `CONVENTIONS.md` |
| A standing fact about the system | `CONTEXT.md` |
| Why a specific piece of code is shaped that way | a comment on that code |
| A follow-up that is still open | a ticket in the effort that owns it |

Whatever is left — the triage notes, the verification tables, the narrative — has
served its purpose. It stays in git history, and the commit that shipped the work
carries the reasoning. This is the same treatment `.planning/` and `review/` got.

The failure mode this avoids: a reader finding a stale ticket and treating it as
current, or a decision surviving only in a file nobody thinks to read.

## Where the history went

An earlier planning system's artifacts (`.planning/`) were removed once their durable content was mined into `CONTEXT.md`, `docs/adr/`, `CONVENTIONS.md`, and this tracker. They remain in git history. **Don't recreate that structure** — new work goes here.
