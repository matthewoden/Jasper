# Issue tracker: the `tracker` MCP server

Issues and specs (you may know a spec as a PRD) for this repo live in the **tracker MCP
server**, in the project keyed **`JASPER`**. There is no `.scratch/` directory any more — see
[Where the history went](#where-the-history-went).

Reach it with the `mcp__tracker__*` tools: `list_projects`, `list_issues`, `get_issue`,
`create_issue`, `update_issue`, `bulk_update_issues`, `list_labels`, `delete_issue`.

## Shape

Issues form a three-level hierarchy — **feature → story → subtask**:

| Level | What it holds here |
| --- | --- |
| **feature** | The spec. Goal, locked decisions, what's out of scope, sequencing across its stories. One feature per effort. |
| **story** | One implementation ticket: the finding or change, its evidence, and its "Done when". |
| **subtask** | A step inside a story that someone else might pick up. Most stories need none. |

A feature has no parent; a story's parent is a feature (or nothing); a subtask's parent must
be a story. A parent is always in the same project.

- **Every issue in this repo goes in `JASPER`.** `TRACK` is the tracker's own project — not ours.
- **`description` is the ticket.** Markdown, and the same prose that used to live in a
  `spec.md` or an issue file. Write it for someone reading it cold.
- **`agent_notes` is a scratchpad**, not a log — what was tried, what to avoid, where the
  thread was left. It is disposable and has no history: writing replaces it. Anything worth
  keeping goes in the description instead. Features and stories carry notes; subtasks don't.
- **Link tickets by identifier** — `JASPER-14`. That is a ticket's name now; see
  [`CONVENTIONS.md` § Ticket identity](../../CONVENTIONS.md#ticket-identity).
- **Link repo files by repo-relative path** — `docs/adr/0011-manual-refresh-over-filesystem-watcher.md`.
  A ticket is not on disk beside them, so relative links (`../../docs/...`) resolve to nothing.

## Two axes: status and label

They are independent, and both matter.

**`status`** is where the work is: `backlog` → `todo` → `in_progress` → `done` (or
`canceled`, meaning decided against).

**Labels** carry the triage role — who the ticket is waiting on. The five canonical roles and
their strings are in [`triage-labels.md`](./triage-labels.md). Call `list_labels` before
labelling so an existing name is reused rather than a near-duplicate invented.

Reading a queue: `list_issues` with `active: true` returns only what is neither done nor
canceled — add `label: "ready-for-agent"` for the AFK queue, or `project_key: "JASPER"` to
stay in this repo. A label filter *alone* also returns closed issues whose role was never
cleared, which read as work waiting that nobody has to do.

## When a skill says "publish to the issue tracker"

`create_issue` in `JASPER`. Pick the level (feature for a whole effort, story for one ticket),
set `parent` when it has one, set `status`, and label it with its triage role.

## When a skill says "fetch the relevant ticket"

`get_issue` with the identifier — e.g. `JASPER-14`. It returns the description, the agent
notes, and the direct children. The user will normally pass the identifier directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a feature; each **child ticket** is a story under it.

- **Map**: the feature's `description` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: a story whose body carries the question. Record the ticket type
  (`research`/`prototype`/`grilling`/`task`) as a `Type:` line at the top of the description.
- **Blocking**: a `Blocked by: JASPER-NN, JASPER-NN` line near the top of the description. A
  ticket is unblocked when every issue it lists is `done`.
- **Frontier**: `list_issues` with the feature as `parent` and `active: true`; take the open,
  unblocked, unclaimed one — lowest identifier wins.
- **Claim**: set `status: "in_progress"` before any work.
- **Resolve**: append the answer under an `## Answer` heading in the description, set
  `status: "done"`, then append a context pointer (gist + identifier) to the map's
  Decisions-so-far in the feature's description.

`update_issue` **replaces** the description — read it first and send the merged text, or you
will delete the body you meant to append to.

## Closing an effort

**Move the durable content out as you close each story, not when the effort ends.** A closed
issue is not deleted, but it is off the board and out of the way — `list_issues` shelves a
feature whose whole subtree has been closed for more than three days, along with that subtree.
A decision that lives only there is a decision nobody will find.

| What | Where it goes |
| --- | --- |
| A decision, and the alternatives rejected | an ADR in `docs/adr/` |
| A rule about how we work | `CONVENTIONS.md` |
| A standing fact about the system | `CONTEXT.md` |
| Why a specific piece of code is shaped that way | a comment on that code |
| A follow-up that is still open | a new story, in the feature that owns it |

`CONVENTIONS.md` carries this as a rule; the table above is where things go.

Whatever is left — the triage notes, the verification tables, the narrative — has served its
purpose. The commit that shipped the work carries the reasoning.

### The closing pass

If extraction happened per-story, this is a verification sweep rather than a salvage
operation. Before setting the feature `done`:

- [ ] **Every shipped finding's reasoning has a home outside the tracker** — or is genuinely
      not durable. A rejected alternative almost always is: it is the thing a future reader
      will try first.
- [ ] **No open follow-up is recorded only in a closing ticket.** Move it to the feature that
      owns it, or file it as its own backlog feature.
- [ ] **Nothing in the repo cites a ticket as authority** —
      `grep -rn "JASPER-" --exclude-dir=.git .` should turn up nothing load-bearing. An ADR
      that cites a ticket is a permanent record depending on a disposable one. State the fact
      in the ADR and let it stand alone: "the shipped teardown order is a known defect" needs
      no ticket link to be true or actionable.
- [ ] **Identifier schemes local to the effort have a provenance note** if they appear in
      commit messages or git history, so old references stay decodable. See
      [`CONVENTIONS.md` § Ticket identity](../../CONVENTIONS.md#ticket-identity).

A close that turns up several unextracted decisions is a signal the discipline slipped, not a
reason to keep the feature open.

**Prefer `canceled` or archiving to `delete_issue`.** Deleting is irreversible; archiving is
not, and canceled says *decided against*, which is information.

## Where the history went

Two earlier systems fed this one, and neither should be recreated:

- **`.planning/`** — roadmaps, phase plans, verification logs, UAT rounds, retrospectives.
  Removed once its durable content was mined into `CONTEXT.md`, `docs/adr/`, `CONVENTIONS.md`.
- **`.scratch/`** — the markdown tracker that replaced it: one directory per effort, a
  `spec.md`, and numbered issue files under `issues/`. Migrated into this tracker on
  2026-08-22 and deleted. Every live effort became a feature with its issues as stories.

Both remain in git history. Old commit messages and comments cite `.scratch/<effort>/NN`
paths; the migration commit is where those resolve to identifiers.
