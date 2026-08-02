# ADR-0008 — Obsidian-style vault model with an always-on server

**Status:** Accepted 2026-05-23 · *(originally recorded as ADR-001)*

## Context

The original model booted the server with a single bootstrap data directory, resolved as `--data-dir` flag → `$JASPER_DATA_DIR` → `~/.jasper`. A first-run wizard then asked the user for a "Data Directory" path and wrote setup files *there*.

If those two paths differed, setup silently failed: the wizard wrote to the path the user typed, the running process still held the bootstrap path, the first-run middleware re-checked the bootstrap path, found nothing, and fired the wizard again.

The hidden invariant was that the user had to type the same path the binary was started with. It was undocumented, unvalidated by the UI, and contradicted by the wizard's own copy ("Pick an empty folder you already own"). UAT confirmed it reads as "pick where your notes go," not "echo back the argument you already passed."

## Decision

Adopt an Obsidian-style **vault** model. Jasper opens one vault at a time and hot-swaps to switch.

**Two persistence locations, two responsibilities:**

| Location | Scope | Contents |
|---|---|---|
| `~/.jasper/app.json` (overridable via `$JASPER_APP_HOME`) | App-level | `current_vault`, `recent_vaults`, app-level preferences |
| `<vault>/.jasper/` | Vault-level | `config.json`, `app.db`, `logs/`, per-vault UI stores |
| `<vault>/notes/` | Vault-level | The user's markdown files |

**Boot:** read `app.json`; if `current_vault` is set and still exists, open it; otherwise serve the **vault picker** at `/`. The first-run wizard becomes a vault picker plus a per-vault preferences pane — no path-picking.

**Hot-swap:** pause writes and broadcast `vault.switching` → swap the HTTP handler to nil so every in-flight request gets a 503 → tear down the per-vault subsystems → update `app.json` atomically → reopen and run pending migrations → broadcast `vault.switched`. One switch in flight at a time.

> **The shipped teardown order is a known defect, not the contract.** It closes the DB pair before stopping the MCP listener, so an in-flight MCP tool call can hit a closed database. MCP must stop first. Earlier documentation blessed the current order as design; it isn't, and the fix is unshipped as of 2026-08-01.

**`--data-dir` and `JASPER_DATA_DIR` retire** from the user-facing surface, replaced by `--vault` (kept for CI, E2E, and power users).

## Rationale

The asymmetry is resolved *structurally* rather than papered over with documentation — there is no bootstrap data directory anymore, so there is nothing for the user's choice to disagree with.

"Vault" is also the term every Obsidian-adjacent user already carries. "Data directory" is jargon that requires understanding the app's internals.

## Consequences

**Positive**
- Multi-vault workflows (work / personal / scratch) get a real story.
- Per-vault MCP grants become obvious rather than accidental — grants live in the vault's own database.

**Negative, accepted**
- **Hot-swap is genuinely hard.** Five subsystems hold per-vault state and need orderly teardown and reopen. This is a phase-sized problem, not a polish item — and it produced a real bug: an early implementation left the old vault's handler live during teardown, so a request could be served, and a grant written, against the wrong vault's database. The fix (swap the handler to nil *before* teardown; install the new handler only *after* the ACL is set) is why the 503 window exists and why it must not be optimized away.
- Two config surfaces means two loading paths, two test surfaces, two migration surfaces.

## Ordering constraint worth preserving

During a swap, the first non-503 response must be **coherent** — fully wired, ACL included. Installing the new handler before its dependencies are set produces a window where the API answers 200 with empty or wrong data, which is worse than answering 503.
