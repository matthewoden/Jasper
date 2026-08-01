# ADR-0004 — Native single binary + OS service, not Docker

**Status:** Accepted

## Context

The deployment target is a single user self-hosting on their own macOS or WSL2 machine, with a coworker-friendly install story: someone should be able to stand Jasper up without hand-holding.

Docker is the reflexive answer for self-hosted software.

## Decision

The primary install model is a single static Go binary registered as an OS service — a launchd LaunchAgent on macOS (`~/Library/LaunchAgents/`, per-user, no sudo), a systemd user unit in WSL2. Docker is not the default path.

`jasper install` / `uninstall` / `status` / `doctor` wrap the service registration via `kardianos/service`.

## Rationale

For single-user desktop self-hosting, native install gives a smaller footprint, native auto-start at login, simpler upgrades (replace one file), and no Docker daemon dependency. Docker's advantages — isolation, reproducibility, orchestration — mostly serve deployment models Jasper doesn't have.

## Consequences

- The binary must have **no native dependencies**, which forces [ADR-0005](./0005-pure-go-sqlite.md).
- Install correctness is platform-specific and has to be validated per platform, not assumed. macOS is validated by real use; WSL2 is validated by a Dockerized systemd harness in CI (the one place Docker *is* used — as a test fixture, not a delivery mechanism).
- Code signing and notarization on macOS are deferred; the README documents the Gatekeeper workaround. This is an external blocker (needs an Apple Developer ID), not a design gap.
- **The launchd plist uses the dict form `KeepAlive: {Crashed: true}` plus `ThrottleInterval=60`, not `<key>KeepAlive</key><true/>`.** The plain boolean form restarts the service even after a graceful `launchctl bootout` — meaning the user cannot stop Jasper. A regression test pins the dict form; don't "simplify" it.
- Docker may exist as a secondary artifact post-v1. It is not the supported path.

## Lesson recorded

The systemd install harness existed for an entire milestone before it was ever actually run. Its first real execution on an x86_64 Linux kernel surfaced roughly seven latent defects — cgroup-v2 boot, linger, dbus/polkit ordering, uninstall PAM session — that no amount of static review had found. **Authored is not validated.** Run install and service harnesses on a real target kernel before trusting them.
