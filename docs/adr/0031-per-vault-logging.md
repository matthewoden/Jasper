# ADR-0031: The log file is per-vault, always on, and teed with the console

**Status:** Decided 2026-08-01

## Context

Everything in the product that says "check the log" means one file:
`<vault>/.jasper/logs/jasper.log`. The migration runner embeds its path in
every status, the startup-error page tails it, `unrecoverable.html` is built
from it, and `jasper doctor` reports on it.

That file was never written. The file logger was constructed only when the
caller had injected no logger — `if cfg.Logger == nil` — and `jasper serve`
always injects a stderr logger. The guard never fired. On a migration failure
or an unrecoverable boot, precisely when the log is the only diagnostic
surface left, the user was pointed at a file that did not exist.

Two smaller versions of the same confusion sat beside it: `jasper doctor`
probed `<vault>/logs`, and the service manager's stdout capture went to a
third directory again. Three advertised locations, one of which nothing wrote.

## Decision

**`Config.Logger` is the console handler. The vault's file handler is always
added to it.** The nil-guard semantics invert: the caller is not offering a
logger the app may or may not need, it is supplying one half of a tee.

**The tee lives at the handler level, not the writer level.** `jlog.Fanout`
duplicates each record to the console handler and a JSON handler over the
rotating file sink; each formats independently.

**`cfg.Logger` is assigned once, in `App.New`, and never reassigned.** It
wraps a handler holding an `atomic.Pointer` to whatever is currently
installed. Opening a vault installs console+file; tearing one down closes the
sink and reinstalls console-only.

**The file is attached before any step that can fail**, on both the boot and
the vault-swap path, and `vault.LogsDir` is the single advertised location —
doctor probes it and the service manager's stdout capture sits beside it.

## Alternatives rejected

**Tee at the writer level (`io.MultiWriter`).** The obvious shape, and wrong
here: the rotating sink renames `jasper.log` out from under itself on the
first write of a new day. It can only do that safely while it is the sole
owner of the file handle. A writer-level tee would have forced rotation to
coordinate with a second writer for no gain, since the two sinks want
different formats anyway (text to a terminal, JSON to a file).

**Reassigning `cfg.Logger` on each vault open.** Simpler to read, and a data
race: `SwitchVault` runs on an HTTP goroutine while the boot goroutine still
reads the field. The indirection also buys a correctness property reassignment
cannot — subsystems wired with the logger during vault A's boot are never
re-handed one, so under reassignment they would keep writing to A's closed
file after a swap. Through the atomic pointer they follow the swap.

**Keeping the service manager's stdout capture in its own directory.** It is a
genuinely different artifact — it catches panics and pre-boot stderr that the
structured logger never sees — but that is an argument for a different
*filename*, not a different directory. One place to look.

## Consequences accepted

- **A vault that cannot be written to fails boot earlier**, at log-attach
  rather than at first index write. The error path is the static error page,
  which is the correct destination anyway, but the failing step is named
  "File logger" rather than something closer to the real cause.
- **Every record is formatted twice.** Immaterial at this volume; the cost is
  paid per record, not per byte, and one sink is usually `io.Discard` in tests.
- **A derived logger (`.With(...)`) re-applies its attribute chain on every
  record** rather than once at derivation. The undecorated handler — nearly
  every call site — is unaffected.
- **`Fanout` swallows a failing child**, returning the first error but still
  delivering to the others. A file sink closed under us must not silence the
  console; the cost is that a persistently failing file sink is quiet unless
  something checks. Acceptable because the console is the fallback, not the
  other way round.
- **The logs directory is created 0700**, consistent with
  [ADR-0030](./0030-vault-directory-permissions.md), so a pre-existing
  0755 one from another tool is not tightened — `MkdirAll` leaves an existing
  directory's mode alone. Nothing has ever created that directory but Jasper,
  so this is theoretical today.

## See also

- [ADR-0008](./0008-vault-model.md) — per-vault state and the hot-swap teardown order
- [ADR-0028](./0028-migration-resilience-mechanics.md) — the failure paths whose error pages tail this file
- [ADR-0030](./0030-vault-directory-permissions.md) — why `.jasper/` and its contents are 0700
