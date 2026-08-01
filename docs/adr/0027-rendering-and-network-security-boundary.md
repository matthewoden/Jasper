# ADR-0027 — The rendering and network security boundary

**Status:** Accepted (foundational — v1.0)

## Context

[ADR-0002](./0002-no-plugin-surface.md) removes the plugin attack surface. That guarantee is worth nothing if note *content* can execute script, or if the app quietly reaches the network.

Note content is untrusted in the relevant sense: it can be pasted from anywhere, synced from another machine, or written by an MCP client.

## Decision

**Rendering boundary**

- A strict Content Security Policy on every response:
  `default-src 'self'; img-src 'self' data: blob:; script-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data:; style-src 'self' 'unsafe-inline'`
- All markdown-to-HTML output is sanitized with **DOMPurify** under a strict allowlist before insertion. No `dangerouslySetInnerHTML` on raw model output, anywhere.
- **External `<img>` tags in note content are blocked by default** and rendered as a click-to-load placeholder.
- `Referrer-Policy: no-referrer` on every response.

**Network boundary**

- **No external CDN, font, script, or analytics resource is loaded at runtime.** The app is fully functional offline once loaded.
- **No telemetry, analytics, or third-party crash reporting.** Logs stay on the user's machine.
- **No auto-update from the internet at runtime.** Upgrades are user-initiated by replacing the binary.

## Rationale on the image rule

Blocking external images is the least obvious of these and the easiest to argue away as paranoid. It prevents a **tracking-pixel leak**: a remote `<img>` in a note discloses the reader's IP address, approximate location, and the fact and time of reading, to whoever authored the note. For a private notes app that can receive content from elsewhere, that's a real leak with no compensating benefit — click-to-load preserves the capability while making the disclosure a deliberate act.

## Rationale on the network rules

Self-hosting means the user's machine, the user's data, the user's network. A runtime CDN dependency would break offline use and hand a third party a request log of when the app is used. Autonomous network access is also inconsistent with the posture that justifies the whole project — a binary that phones home is a binary the security review has to reason about.

## Consequences

- All assets are embedded in the binary at compile time. There is no "just pull the font from Google" shortcut.
- Adding any runtime fetch to a non-local origin contradicts this ADR. If one is ever needed, it needs an explicit amendment, not a `connect-src` widening.
- `style-src` allows `'unsafe-inline'` — a deliberate, scoped concession for CodeMirror's inline styling. It is the one loosened directive; don't loosen others by analogy.
- Any new rendering surface — including a docs site served from the binary — inherits the same sanitization discipline, even when its content is developer-authored and nominally trusted.
