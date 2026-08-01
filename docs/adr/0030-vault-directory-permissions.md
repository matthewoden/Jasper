# ADR-0030 — Vault directory permissions: 0700 for Jasper's data, 0755 for notes

**Status:** Accepted 2026-08-01

## Context

Three places in the codebase disagreed about how permissive a vault should be, and had done since the vault model landed:

| Site | Mode | |
|---|---|---|
| `app.EnsureDataDir` | `0755` on `notes/`, `.jasper/`, `.trash/` | with a comment explaining the choice deliberately |
| `vault.CreateVault` | `0700` on `.jasper/` | |
| `jasper doctor` | **requires** `0700` on `.jasper/` | fails otherwise |

The consequence: a vault created by `jasper serve` was world-readable **and failed Jasper's own health check**. A vault created by the first-run wizard was not. Neither behaviour was chosen; they were two answers to a question nobody had asked out loud.

The SQLite index compounded it. It opens with no explicit mode, so the driver default `0644` applied — and that database holds **full note bodies** in the `body_fts` table, along with titles, tags, backlinks, and `mcp_write_grants`.

## The argument that produced `0755`

The lifecycle comment was not careless. It said:

> `0o755` (not `0o700`) because Jasper runs as the user … A more restrictive `0o700` would surprise sync tools

That is a real concern. Jasper has no sync of its own; the cross-device story *is* an external tool ([ADR-0003](./0003-single-user-no-auth.md)), and Syncthing, iCloud and Dropbox do run under contexts that a `0700` tree can block.

## The argument that produced `0700`

The vault contains everything the product promises to keep private. On a multi-user host — precisely the WSL "coworkers self-host" case — `0755` lets any other local user read every note straight off disk, which contradicts "full local ownership of the underlying files."

And the sync rationale does not obviously extend to the **index database**. It is derived, but derived content is still content.

## Decision

Split by *whose data it is*, not by one blanket mode:

| Path | Mode | |
|---|---|---|
| `notes/` | `0755` | the part users legitimately point other tools at |
| `.jasper/` | `0700` | Jasper's own data — index DB, logs, config |
| `.trash/` | `0700` | deleted note content |
| `.jasper/app.db` + `-wal` + `-shm` | `0600` | applied via `os.Chmod` after open |

Applied at **all three sites** — `app.EnsureDataDir`, `vault.CreateVault`, and `doctor`'s check — so they stop contradicting each other. `doctor`'s existing `0700` rule was already right; it was the writer that disagreed.

Two details that are easy to get wrong and are therefore load-bearing:

- **The `-wal` and `-shm` siblings are chmod'ed too.** Recent writes live in the WAL. Tightening only `app.db` would leave the newest note content readable and look finished.
- **`EnsureDataDir` re-chmods on every startup, not just on create.** `MkdirAll` leaves an existing directory's mode untouched, so vaults created by the previous code would have stayed `0755` — and kept failing `doctor` — forever.

## Consequences

- The sync concern is **preserved where it applies**. A user pointing Syncthing at `notes/` is unaffected; that was always the directory they meant.
- A user pointing a sync tool at the **whole vault** now sees `.jasper/` as unreadable under a different user context. This is accepted: the index is regenerable from `notes/` by design, so it is the one directory that does not need to survive a sync.
- Startup tightens the mode of a directory the user may have deliberately loosened. This is a one-way ratchet toward restriction and is not configurable. If someone has a real reason to loosen `.jasper/`, this ADR is what they should argue with.
- `doctor` now passes on a freshly created vault, which makes the check meaningful for the first time. `TestCheckDataDirPerms_PassesOnFreshlyCreatedVault` runs the real writer against the real checker — a test on either side alone stays green while the two disagree.
- Windows has no POSIX mode bits; the checks and tests skip there, as `doctor` already did.
