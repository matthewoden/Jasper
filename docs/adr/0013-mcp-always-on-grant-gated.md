# ADR-0013 — MCP is always-on, loopback-enforced, and governed solely by per-folder grants

**Status:** Accepted (grant model v1.0; global toggle removed 2026-07)

## Context

Jasper exposes notes to Claude Desktop over the Model Context Protocol — read tools (`list_notes`, `read_note`, `search_notes`, `read_attachment`) and write tools (`create_note`, `update_note`, `move_note`, `delete_note`).

This is in tension with [ADR-0002](./0002-no-plugin-surface.md), and the tension is the point of this record.

Originally there were two controls: a global `mcp.enabled` toggle *and* per-folder write grants.

## Decision

1. The MCP listener is **loopback-enforced**, always, on a second port (default 6684), via `netbind.RequireLoopbackBind` at startup. This holds regardless of the HTTP listener's bind address.
2. The listener **always starts**. The global `mcp.enabled` toggle is removed; the config field survives as a deprecated ignored key so legacy configs still parse.
3. Access is governed **solely by per-folder write grants**, default-deny. A user who wants zero AI access grants nothing.

## Rationale

**On the exception to ADR-0002:** this is a controlled exception, not a regression. MCP exposes *data* over a loopback-only socket under an explicit default-deny ACL. It does not execute foreign code inside Jasper, which is the actual risk ADR-0002 exists to prevent. The security boundary is preserved structurally.

**On removing the toggle:** once grant management was decoupled from the listener, a separate enable/disable flag was redundant with grant-gated access. Two overlapping controls invited exactly the confusing states — "enabled but no grants," "disabled but granted" — that a single mechanism avoids.

## Consequences

- **`TestMCPAlwaysLoopback` is load-bearing.** The invariant is enforced by a named regression test, not by a comment. Any change that touches MCP binding — including making the port configurable — must route through the same `RequireLoopbackBind` call and extend that test's coverage to the new path.
- Grants live in the vault's own database, so they are per-vault by construction. A hot-swap must therefore install the new ACL *before* the handler starts serving; otherwise the API answers with an empty grant set. See [ADR-0008](./0008-vault-model.md).
- **The ACL has one axis, deliberately: folder-scoped read/write.** Per-verb granularity (allow `move_note` but not `delete_note` on a folder) was considered and rejected — it multiplies Settings complexity without a requested use case, and the audit log is the mechanism for after-the-fact accountability rather than preventative per-verb gating.
- An MCP audit log must be metadata-only — tool name, target path, timestamp, outcome, authorizing grant. **Never note content or diffs.** A content-bearing audit log would create a second, ungoverned copy of the user's data outside the filesystem-source-of-truth model, which undermines the product's central promise. It must also be async and capped; see [ADR-0007](./0007-file-first-save-path.md) on fourth steps in the write path.
