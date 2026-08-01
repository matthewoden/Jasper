# ADR-0020 — Config is lenient on read, strict on write

**Status:** Accepted (implemented; closes the long-deferred SET-05 gap)

## Context

`config.Load()` used to decode with `DisallowUnknownFields()`. On **any** unrecognized key it logged a warning and returned `DefaultConfig()` — silently discarding every real user setting for that boot.

This was tracked as SET-05 and deferred across three milestones. It got worse as the config surface grew: a newer binary's field, or one hand-edited key, wiped the whole file's effective contents. The per-field workaround — add each field with `omitempty` plus a "kept for legacy parse" comment — doesn't scale past a couple of fields, and one milestone was about to add six at once.

## Decision

Split the two directions. They have different threat models, so they get different rules.

**Read path (`config.Load`) — lenient, per field.** A two-pass decode into `map[string]json.RawMessage`, then per-field decode onto a `DefaultConfig()` base:

| Situation | Behavior |
|---|---|
| File missing | Return defaults **and** write them to disk |
| Genuinely unparseable JSON | Warn, return defaults, **leave the bad file untouched** for forensics |
| Unrecognized key (top-level or nested) | Silently dropped; every recognized field keeps its on-disk value |
| Known field, wrong type or out of range | **That field alone** reverts to its own default — never clamped to the bound — with a warning naming the field and reason. Every sibling, including siblings in the same nested section, keeps its on-disk value |

`Load` returns an error only when the disk is unreadable for non-not-exist reasons. Startup is not gated on config.

**Write path (`PUT`/`PATCH /config`) — strict.** `ConfigStrictBodyMiddleware` rejects malformed or unknown fields before they ever reach disk.

## Rationale

Leniency on read only ever has to absorb a **hand-edited or cross-version file**. It never has to absorb a fresh write from the current binary, because the write path already rejected anything malformed.

So strictness costs nothing where it's cheap (the wire, where a bad request can just be refused) and leniency is applied only where the alternative is destroying user data.

Reverting an out-of-range field to its default rather than **clamping** it is deliberate: clamping invents a value the user never chose and hides the problem. Reverting plus a named warning is honest.

This mirrors the lenient-decode pattern already proven in the per-vault JSON stores ([ADR-0018](./0018-clone-the-store-per-vault-json.md)) — the same forward-compat lesson, finally applied to the config loader.

## Consequences

- A downgrade — older binary, newer config file — degrades gracefully instead of resetting the user's settings.
- **Three surfaces still have to agree on the config shape:** `api/openapi.yaml`, `config.Config`, and the hand-maintained `strictConfigValidator` mirror in `internal/api/config_validate.go`. Adding a field to two of the three passes `go build` and `make gen-check`, then 400s at runtime on the first write carrying it. A drift test guards the validator against `config.Config`; keep it passing.
- `strictConfigValidator` has an all-pointer twin, `strictConfigPatchValidator`, for `PATCH` ([ADR-0021](./0021-config-patch-server-side-serialisation.md)). A value-typed validator would read an omitted field as a zero value, which is wrong for partial updates.
- Per-section Reset must assign only that section's sub-struct. Resetting the whole struct would blow away settings the user didn't touch.
