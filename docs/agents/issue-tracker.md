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

**Move durable content out as you close each ticket, not when the directory dies.**
Retirement happens once, at the end, across tickets nobody has read recently — the
worst possible moment to reconstruct why something was decided. By then the
reasoning is a paragraph in a file you are about to delete, and waving it through
costs nothing until someone needs it. `CONVENTIONS.md` carries this as a rule; the
table below is where things go:

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

### The retirement pass

If extraction happened at close, this is a verification sweep rather than a
salvage operation. Walk the directory once and confirm:

- [ ] **Every shipped finding's reasoning has a home outside `.scratch/`** — or is
      genuinely not durable. A rejected alternative almost always is: it is the
      thing a future reader will try first.
- [ ] **No open follow-up is recorded only here.** Move it to the effort that owns
      it, or promote it to `backlog/`.
- [ ] **Nothing outside `.scratch/` links into the directory** —
      `grep -rn "<effort-slug>" --exclude-dir=.scratch --exclude-dir=.git .`
      should come back empty. A dangling link in an ADR or a code comment is worse
      than the ticket surviving.

      Better still, don't create them: an ADR that cites a ticket path is a
      permanent record depending on a disposable one. State the fact in the ADR
      and let it stand alone — "the shipped teardown order is a known defect"
      needs no ticket link to be true or actionable.
- [ ] **Identifier schemes local to the effort have a provenance note** if they
      appear in commit messages or git history, so old references stay decodable.
      See `CONVENTIONS.md` § Ticket identity.

Then delete it. A retirement that turns up several unextracted decisions is a
signal the close discipline slipped, not a reason to keep the directory.

## Where the history went

An earlier planning system's artifacts (`.planning/`) were removed once their durable content was mined into `CONTEXT.md`, `docs/adr/`, `CONVENTIONS.md`, and this tracker. They remain in git history. **Don't recreate that structure** — new work goes here.
