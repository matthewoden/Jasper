# ADR-0002 — No plugin, extension, or scripting surface — ever

**Status:** Accepted (foundational; permanent, not deferred)

## Context

Obsidian is the reference product for Jasper's feel, and its plugin ecosystem is a large part of its value. But the project owner's company will not accept Obsidian's community-extension surface as a security risk. That refusal is the entire reason Jasper exists.

## Decision

Jasper has no plugin API, no extension mechanism, and no user-supplied scripting. This is permanent scope exclusion, not a "v2 maybe."

Foreign code execution is the exact risk the product is built to avoid. Open-source code, no plugin runtime, and full data ownership are what make Jasper viable where Obsidian isn't.

## Consequences

- Every feature ships in the binary or doesn't exist. There is no escape hatch of "a plugin could do that," which means the core feature set has to be genuinely sufficient.
- This is the spine of every scope "no" in the project. When a feature request implies extensibility, the answer is to build the specific thing or decline it — never to build a general mechanism.
- The MCP server is the one controlled exception, and it is principled rather than a regression: it exposes *data* over a loopback-only listener under a default-deny per-folder ACL. It does not execute foreign code inside Jasper. See [ADR-0013](./0013-mcp-always-on-grant-gated.md).
- A strict CSP and a DOMPurify boundary guard the rendering surface, because "no plugins" is worthless if note content can inject script.

## The templates boundary

Templates are the place this decision is most likely to erode, because template systems drift toward scripting. Obsidian's own ecosystem demonstrates the endpoint: Templater executes JavaScript, prompts for input, and includes other files.

**Jasper's templates are static token substitution only, permanently.** A closed, explicit set of variables (`{{date}}`, `{{date:FMT}}`, `{{longdate}}`, `{{title}}`, `{{time}}`, `{{cursor}}`), with unrecognized `{{tokens}}` left untouched rather than evaluated or erased.

No JavaScript execution, no prompts, no file includes, no recursive expansion — a variable must never resolve to something that is itself template syntax. The closed token set is a security boundary, not just a correctness one.

## Note for future work

If a proposal's justification includes the phrase "users could extend it themselves," it contradicts this ADR. Surface the conflict rather than quietly narrowing the mechanism until it looks acceptable.
