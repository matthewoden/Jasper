# ADR-0003 — Single user per instance; no authentication

**Status:** Accepted

## Context

Jasper is used by the project owner and a small group of coworkers. Each person self-hosts their own instance on their own machine. The server binds to loopback by default.

"Should there be login?" recurs naturally, because a server that speaks HTTP looks like it wants users.

## Decision

One user per instance. No accounts, no per-user authentication, no authorization model beyond the MCP grant ACL.

This is a documented scope exclusion with reasoning, not an oversight or a deferred nice-to-have.

## Rationale

Adding auth would justifiably double v1 scope — login flows, session management, password storage, recovery, and a permissions model — without serving the actual deployment model, in which the operating-system user account *is* the security boundary.

## Consequences

- The security posture rests on **bind address** rather than credentials. This makes [ADR-0014](./0014-retire-settings-bind-control.md) load-bearing: exposing the listener beyond loopback is a deliberate act, because there is no second line of defense behind it.
- CSRF Origin validation on state-mutating routes is always on, not gated on the bind value — it's the one protection that still applies when the listener is reachable from elsewhere on the host.
- Real-time collaborative editing is out of scope for the same reason. Multi-*session* sync (the same user in several tabs) is supported and sufficient.
- Cloud sync and a hosted multi-user version are permanently out of scope. Users own their files and use external sync — Syncthing, iCloud, git — if they want cross-device.
- **Encryption at rest is out of scope**, for the same reason: a single user on their own machine is already covered by OS disk encryption (FileVault, BitLocker). Adding an application-layer encryption story would complicate the "your files are plain markdown on disk" promise without changing the threat model.

## Note

Absence of auth is frequently mistaken for a defect during review. It is not. A withdrawn revision of [ADR-0014](./0014-retire-settings-bind-control.md) was built on exactly that misreading.
