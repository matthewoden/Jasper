# ADR-0014 — Retire the Settings bind-address control; keep `--bind`

**Status:** Accepted 2026-07-26 (v2) · *(originally recorded as ADR-002; v1 withdrawn — see below)*

## Context

The HTTP listener defaults to `127.0.0.1` and can be bound elsewhere. That capability shipped deliberately as a tracked requirement, with CSRF Origin validation as an explicit precondition and the MCP listener hard-locked to loopback regardless. It was exposed through three surfaces: a `--bind` flag, a `server.bind` config field, and a Settings UI field.

The capability originated from a narrower concern — a WSL2 install might not be reachable on loopback — whose sketched fix was *automatic detection*, not a user-facing knob. A platform-compatibility problem was generalized into a general-purpose control, and the original framing dropped out. No use case for LAN access is recorded anywhere.

### The decisive finding

**The SPA and the API are served by one listener.** Therefore: *if the bind address is unreachable, the Settings screen is unreachable.*

The control can only be operated when it isn't needed. The founding use case — an install unreachable on loopback — is addressable only by the flag or a hand-edited config file. The Settings surface is the one of the three that structurally cannot solve the scenario that motivated it.

### The exposure asymmetry

| Platform | `0.0.0.0` actually exposes to | Delta |
|---|---|---|
| macOS (primary target) | The real LAN | Large |
| WSL2, NAT mode (default) | Windows host + virtual switch; physical LAN needs extra setup | Small |
| WSL2, mirrored mode | Shares host interfaces → the real LAN | Large |

The security cost is highest on macOS; the motivating use case lives on WSL2. The control put the largest-delta action one click away on the platform where it matters most.

## Decision

Retire the Settings UI bind control. **Keep `--bind` and `server.bind` unchanged.** Defer WSL2 reachability to startup detection if it is ever shown to be a real problem.

Do **not** apply loopback enforcement to the HTTP listener — that would revoke a satisfied requirement. Loopback-enforcement applies to MCP only ([ADR-0013](./0013-mcp-always-on-grant-gated.md)).

## Rationale

- The control cannot serve its own use case (verified in this codebase, not reasoned).
- It is the highest-exposure surface on the highest-exposure platform, for a scenario living elsewhere.
- No recorded demand, anywhere.
- **Deliberate acts should look deliberate.** A CLI flag or a hand-edited config file is considered; a text box in Settings is a click.
- Nothing is lost — `--bind` takes a full `host:port`, while the Settings field was host-only.

## Consequences

- Anyone who set the bind through Settings now uses `--bind` or edits `config.json`. Existing values keep working.
- The component and its Settings entry were **deleted**, not hidden. Restoring a Server settings pane means rebuilding it, not unhiding it.
- WSL2 loopback reachability **remains genuinely unverified.** If it does fail there, the fix is startup detection, not a restored GUI knob.

## Revision history — why v1 was wrong

**v1 proposed deleting the bind capability entirely** and enforcing loopback on the HTTP listener, on the premise that LAN-bindable HTTP was undocumented drift.

Every load-bearing claim in v1 was false. LAN bind was a tracked requirement; CSRF protection was an explicit precondition and exists; MCP loopback enforcement was working as designed; the absence of authentication is a documented scope exclusion ([ADR-0003](./0003-single-user-no-auth.md)), not an oversight.

**The error came from treating a stale documentation line as evidence of a defect** without checking the requirements that would have contradicted it in minutes. Recorded here so the wrong version is not re-derived from the same stale line.

v2 reaches a narrower conclusion by a different route: the *Settings surface* is unjustifiable because it cannot serve its own use case — not because the capability is unsafe.
