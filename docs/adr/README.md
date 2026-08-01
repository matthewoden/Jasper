# Architecture Decision Records

Decisions that constrain future work, with the reasoning that produced them. If your work contradicts one of these, say so explicitly rather than quietly overriding it:

> *Contradicts ADR-0011 (no filesystem watcher) — but worth reopening because…*

Vocabulary and invariants live in [`CONTEXT.md`](../../CONTEXT.md). Process rules — how we build, test, and verify — live in [`CONVENTIONS.md`](../../CONVENTIONS.md).

## Precedence — read this before adding or amending

**The number is an identifier, not a rank.** A higher number does not mean a newer or stronger decision. These are grouped roughly by theme, and several foundational ones (0001–0007) predate almost everything else in the repo.

Precedence is determined by two things, and only these two:

1. **The dated `Status:` line.** Undated entries marked *foundational* were locked pre-implementation, in `DESIGN.md` or the v1.0 requirements. A dated entry was decided on that date.
2. **Explicit supersession links**, written on **both** files. When a new decision overrides an older one, the older one gets `**Superseded by:** ADR-NNNN` at the top and the newer one names what it replaced.

**When a decision evolves on a topic an ADR already covers, amend that ADR — don't mint a new number.** Record the evolution inside the existing file. ADR-0013 works this way: the v1.0 grant model and the v1.2 removal of the global toggle are one document, so there is no way for the older decision to be read as current. ADR-0014 does the same for its withdrawn first revision.

This matters because these records were reconstructed from four shipped milestones at once. An older release must never be able to look like it supersedes a newer decision merely by holding a larger number.

## Index

| # | Decision | Theme |
|---|---|---|
| [0001](./0001-filesystem-is-the-source-of-truth.md) | The filesystem is the source of truth; SQLite is derived | Foundational |
| [0002](./0002-no-plugin-surface.md) | No plugin, extension, or scripting surface — ever | Foundational |
| [0003](./0003-single-user-no-auth.md) | Single user per instance; no authentication | Scope |
| [0004](./0004-native-binary-over-docker.md) | Native single binary + OS service, not Docker | Deployment |
| [0005](./0005-pure-go-sqlite.md) | `modernc.org/sqlite` (pure-Go driver), no CGo | Stack |
| [0006](./0006-openapi-as-the-bilateral-contract.md) | OpenAPI 3.1 is the bilateral contract; both sides generated | Stack |
| [0007](./0007-file-first-save-path.md) | File-first save path: write, then index, then broadcast | Data integrity |
| [0008](./0008-vault-model.md) | Obsidian-style vault model with an always-on server | Architecture |
| [0009](./0009-filename-h1-binding.md) | Bidirectional filename ↔ H1 binding | Content model |
| [0010](./0010-title-only-wiki-links.md) | Wiki-links are title-only; no path syntax | Content model |
| [0011](./0011-manual-refresh-over-filesystem-watcher.md) | Manual refresh instead of a filesystem watcher | Sync |
| [0012](./0012-incremental-reindex-on-startup.md) | Incremental re-index on every startup | Sync |
| [0013](./0013-mcp-always-on-grant-gated.md) | MCP always-on, loopback-enforced, grant-gated | Security |
| [0014](./0014-retire-settings-bind-control.md) | Retire the Settings bind control; keep `--bind` | Security |
| [0015](./0015-filesystem-native-soft-delete.md) | Soft-delete is filesystem-native | Content model |
| [0016](./0016-shared-document-single-writer.md) | One document, many views: module-singleton buffer | Editor |
| [0017](./0017-pointer-events-for-drag.md) | All drag interactions use pointer events | Frontend |
| [0018](./0018-clone-the-store-per-vault-json.md) | Per-vault UI state in cloned JSON stores | Persistence |
| [0019](./0019-obsidian-as-default-ux-reference.md) | Obsidian's behavior is the default for UI and UX | Design |
| [0020](./0020-config-lenient-read-strict-write.md) | Config is lenient on read, strict on write | Persistence |
| [0021](./0021-config-patch-server-side-serialisation.md) | Config partial writes via `PATCH`, server-serialised | Persistence |
| [0022](./0022-shared-api-resource-layer.md) | Shared API resource layer: fetch-once, cache by default | Frontend |
| [0023](./0023-leaf-package-dependency-discipline.md) | `internal/markdown` is a leaf package | Architecture |
| [0024](./0024-pre-launch-no-migration-burden.md) | Pre-launch: no back-compat shims or migrations | Scope |
| [0025](./0025-sqlite-concurrency-posture.md) | SQLite: one writer, a reader pool, WAL | Data layer |
| [0026](./0026-path-canonicalization.md) | Canonicalize paths NFC + lowercase; reject case collisions | Data layer |
| [0027](./0027-rendering-and-network-security-boundary.md) | The rendering and network security boundary | Security |
| [0028](./0028-migration-resilience-mechanics.md) | Migration resilience: three paths, backup-first, listener-last | Data layer |
| [0029](./0029-search-surfaces.md) | Search lives in the palette and a panel, never as a tree filter | Design |

## Renumbering note

0008 and 0014 were previously `ADR-001` and `ADR-002` under `.planning/decisions/`. Their reasoning is preserved here; the phase and plan cross-references from that era were dropped, since they point into an execution record that is historical rather than authoritative. The originals remain in `.planning/decisions/` for as long as that directory exists.

## Adding one

Number sequentially. Record the **context** that forced a choice, the **decision**, and the **consequences you accepted** — including the costs. An ADR whose consequences section only lists benefits is usually a decision that hasn't been examined.

Withdrawn or superseded reasoning stays in the file (see 0014's revision history). The point is to stop a wrong conclusion being re-derived from the same bad premise.
