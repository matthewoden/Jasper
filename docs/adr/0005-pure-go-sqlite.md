# ADR-0005 — `modernc.org/sqlite` (pure-Go driver), no CGo

**Status:** Accepted (locked in `DESIGN.md` §2)

## Context

Jasper needs SQLite with FTS5 for full-text search. The mature, obvious choice is `mattn/go-sqlite3`, which binds the C library through CGo.

CGo means the build needs a C toolchain, cross-compilation gets painful, and the resulting binary carries native linkage.

## Decision

Use `modernc.org/sqlite` — a pure-Go SQLite implementation — compiled with FTS5, JSON1, and RTree.

## Rationale

[ADR-0004](./0004-native-binary-over-docker.md) promises a single static binary that installs without Docker, Xcode, or system libraries. CGo would break that promise on exactly the machines that matter: a coworker's laptop with no developer tooling installed.

This constraint is upstream of the driver choice. The driver is chosen to preserve the install story, not on its own merits.

## Consequences

- `go build` produces a working binary anywhere Go runs. No C toolchain, no `CGO_ENABLED` juggling, no platform-specific build documentation.
- Performance is adequate for the workload (a single user's vault, target 5,000 notes). This has not been a constraint in practice.
- The driver is less battle-tested than the C library. Migration and index behavior are covered by the project's own tests rather than assumed.
- Anything that would reintroduce a CGo dependency contradicts this ADR and, transitively, the install story in ADR-0004.
