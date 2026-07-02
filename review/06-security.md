# 06 — Security

Two focused passes: web/network surface and filesystem/MCP surface. **Headline: the team has done real security work, and the core guarantees hold.** `fsstore.Canonicalize` resolves symlinks before its containment check and every note read/write flows through it (no vault escape); the MCP ACL is component-wise, not prefix-matchable, with correct default-deny; all SQL is parameterized; DOMPurify is locked down; a global CSP + nosniff + X-Frame-Options + an Origin allowlist on mutations are all present. See "Verified secure" at the bottom — for a security-first app it's worth recording what's solid.

The findings cluster around **one root cause: no Host-header validation**, which defeats the loopback posture via DNS rebinding, plus a few defense-in-depth gaps. Severities are judged by realistic exploitability under the localhost single-user model (a drive-by from a page the user visits ranks high; something needing existing code-exec on the box ranks low).

The top three (SEC-01/02/03) verified against source directly: no `r.Host` check exists anywhere in `backend/internal/`; the CSRF guard bypasses safe methods; daily-note GET writes to disk and returns 201.

---

## SEC-01 — No Host-header validation → DNS-rebinding exfiltrates all note content (drive-by)

**Priority:** HIGH · **Executor:** opus · **Effort:** M

### Evidence

No Host check exists anywhere (`grep r.Host` across `backend/internal/` — confirmed none). `csrfOriginMiddleware` only guards unsafe methods:
```go
// backend/internal/app/middleware.go:110-113
if csrfSafeMethods[r.Method] {   // GET/HEAD/OPTIONS bypass entirely
    next.ServeHTTP(w, r); return
}
```

### Attack scenario

Victim opens `http://evil.com` (low-TTL DNS). Attacker rebinds `evil.com` → `127.0.0.1`. Page JS calls `fetch("http://evil.com:6683/api/v1/tree")`, then `/notes/{id}`, `/files?path=…`, `/search?q=…`. After rebind these are *same-origin* (page origin = `evil.com:6683`), so SOP lets the page read the responses; the request carries `Host: evil.com:6683`, which Jasper never checks, and GET bypasses the Origin guard. Result: **full exfiltration of every note.** Port 6683 is the well-known default; only precondition is the tab staying open a few seconds. (Mutations remain safe — rebound POST/PUT/DELETE carry `Origin: evil.com:6683`, rejected by the allowlist. This is read-only exfiltration, but that's the whole value of the app.)

### Fix

Add a Host-allowlist middleware at the router root (before routing), rejecting any `r.Host` not in `{127.0.0.1:port, localhost:port, [::1]:port}` (reuse the host set behind `allowedOrigins`, `app.go:149-159`); for a LAN-bind config, allow the configured hosts. Return 403. This single control closes SEC-01 and SEC-02 and mostly closes SEC-06.

### Done when

An integration test with `Host: evil.com:6683` gets 403 on `GET /api/v1/tree`; loopback Host still 200.

---

## SEC-02 — WebSocket is DNS-rebinding-vulnerable (coder/websocket same-Host shortcut bypasses OriginPatterns)

**Priority:** HIGH · **Executor:** opus · **Effort:** S (rides SEC-01)

### Evidence

`wshub/handler.go:29-38` rejects empty Origin and passes loopback `OriginPatterns` — but coder/websocket authorizes *before* consulting them when Origin host == Host header:
```go
// coder/websocket@v1.8.14/accept.go:239
if strings.EqualFold(r.Host, u.Host) { return nil }  // OriginPatterns never checked
```

### Attack scenario

Under the same rebind, the upgrade to `ws://evil.com:6683/api/v1/ws` sends matching `Origin`/`Host` → accepted regardless of OriginPatterns. Attacker receives the broadcast stream (note create/update/delete/move/tree events). Payloads are metadata-only by design (`hub.go:95-97`), so this leaks note **paths/titles and activity**, not bodies — still meaningful disclosure, and OriginPatterns provides zero protection here.

### Fix

The root Host-allowlist (SEC-01) covers `/ws`. Add an explicit `r.Host` check inside `Hub.ServeHTTP` before `websocket.Accept` as defense-in-depth, since the same-Host shortcut is inherent to the library.

---

## SEC-03 — State-changing GET: `GET /daily-notes/{date}` creates files cross-origin

**Priority:** MEDIUM · **Executor:** opus · **Effort:** S

### Evidence

`api/daily.go:25-101` — GET has get-*or-create* semantics: on miss it runs `fsstore.AtomicWrite` (`:84`) + `index.Upsert` (`:101`) and returns 201 (verified). Because GET is "safe," `csrfOriginMiddleware` never inspects it.

### Attack scenario

Any page the victim visits fires `<img src="http://127.0.0.1:6683/api/v1/daily-notes/2099-12-31">` — Host is loopback (allowed), no Origin enforcement on GET → server creates an empty daily note on disk. Attacker can't read the response (CORS), but the side effect lands. **Not fixed by the Host allowlist** (a direct cross-origin GET carries a legit loopback Host). Impact limited: creates empty dated files (spam/disk churn); can't overwrite existing notes.

### Fix

Split get-vs-create: GET is read-only (404 if absent); creation moves to POST (which the Origin guard then protects). General rule to encode: no GET endpoint mutates the filesystem. (This also aligns with SY-01, which routes daily-note creation through `notes.Service`.)

---

## SEC-04 — User-supplied SVG served inline in the app origin

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** S

### Evidence

`api/files.go:452-457` — `ServeFile` overrides content-type to `image/svg+xml` for `.svg`; `CreateFile` refuses `.md` but accepts `.svg` (`files.go:186-189`). Served from `127.0.0.1:6683` — same origin as the app.

### Attack scenario

Attacker plants `evil.svg` (with `<script>`/`onload`), lures the victim to open `GET /api/v1/files?path=evil.svg` as a top-level document → SVG renders in the app origin; script there has full same-origin API access. **Currently prevented by the CSP alone** (`middleware.go:68-84` sets `script-src 'self'` + nosniff on this response too), which blocks inline script and sniffed-JS execution. That means the mitigation is one CSP relaxation away from becoming critical — hence worth defense-in-depth.

### Fix

On `ServeFile`/`GetAttachment`: send `Content-Disposition: attachment` (or `inline` only for a strict media allowlist that excludes SVG), and/or a per-response `Content-Security-Policy: default-src 'none'; sandbox`. Best long-term: serve raw files from a distinct non-app origin.

---

## SEC-05 — Symlink containment parity gap: REST file/attachment handlers and MCP `read_attachment` don't resolve symlinks like `fsstore` does

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** M

### Evidence

`fsstore.Canonicalize` resolves symlinks before containment (`fsstore/canonicalize.go:66-76`, `EvalSymlinks` on root and target). But the generic handlers reject literal `..`, `filepath.Clean`, string-prefix containment, and `Lstat` **only the leaf**: `api/files.go:44-64,229-261,119-146`, `api/attachments.go:159-182`, and MCP `mcp/adapters.go:97-113`. A symlink on an *intermediate directory component* (e.g. a symlinked `attachments/` or note parent folder) isn't detected — `Lstat` on the leaf reports a regular file, then `os.ReadFile`/`AtomicWrite` follows the symlinked ancestor outside the vault.

### Attack scenario

Precondition: a symlinked directory exists inside the vault — a common Obsidian habit (`notes/shared -> /external/docs`). Then MCP `read_attachment` or `GET /files`/`/attachments` reads files outside the vault, and `POST /files` *writes* uploaded bytes outside it. The AI can't plant the symlink itself (MCP writes go through `fsstore`, which rejects symlink writes), so it's gated on a user-created symlink — MEDIUM, not HIGH.

### Fix

Route these handlers through the same primitive as notes: after computing the path, call `fsstore.Canonicalize(notesRoot, rel)` (or a shared helper running `EvalSymlinks` + containment re-check) instead of string-prefix + leaf-`Lstat`. Applies to `files.go` (GetFile/CreateFile/resolveFileUnderNotes/ServeFile), `attachments.go` (GetAttachment/CreateAttachment), `mcp/adapters.go` (read_attachment). Consolidating on one gate also removes the duplicated 5-rule pipeline (relates to BE-10).

---

## SEC-06 — MCP listener (6684) has no Host/Origin validation

**Priority:** LOW–MEDIUM · **Executor:** opus · **Effort:** S

### Evidence

`mcp/listener.go:31-50` enforces loopback bind but registers the SDK `StreamableHTTPHandler` with no Host/Origin check. Read tools are ungated; writes are ACL-gated.

### Attack scenario

DNS-rebinding to `evil.com:6684` would defeat the loopback posture and drive MCP read tools (full note read). **Caveat that limits it:** MCP StreamableHTTP invokes tools via JSON-RPC POST with `application/json`, triggering a CORS preflight the endpoint doesn't answer → browsers block the actual call. So browser-driven exploitation is largely blocked; real residual risk is a same-machine malicious process (lower in the threat model).

### Fix

Wrap the MCP mux with the same Host-allowlist check (SEC-01), rejecting non-loopback Host. Cheap, closes the residual path regardless of SDK/CORS behavior.

---

## SEC-07 — Data dir, `.jasper/`, and index DB created world-readable

**Priority:** LOW · **Executor:** sonnet · **Effort:** S · *(found by both passes; overlaps OPS-05)*

### Evidence

`lifecycle.go:39-46,167-171,388-392` create `notes/`, `.jasper/`, DB dir, logs dir at `0o755` (comment deliberately picks 0755 to avoid surprising sync tools). The SQLite index DB opens with no explicit mode (`db/sqlite/open.go:62-67`) → driver default `0644`, and it holds full note bodies (FTS `body_fts`), titles, tags, backlinks, and `mcp_write_grants`. Inconsistent with the wizard path (`vault/create.go:63` uses `0o700`) and with `doctor`'s own `0700` requirement (`doctor.go:255-259`) — so a lifecycle-created vault is both world-readable *and* fails Jasper's own doctor.

### Attack scenario

On a multi-user host (the WSL "coworkers self-host" case), other local users read all note content off disk — violating "full local ownership." Non-issue on a single-user Mac — hence LOW.

### Fix

Create `notes/`/`.jasper/`/DB dir/logs dir at `0o700`; `os.Chmod` the DB (+ `-wal`/`-shm`) to `0o600` after open. **Resolve this together with OPS-05** — they're the same 0700-vs-0755 decision seen from the doctor side. One owner decision, applied to writer + doctor consistently.

---

## SEC-08 — Backend emits unescaped user content in `excerpt_html`; only the frontend DOMPurify saves it

**Priority:** LOW · **Executor:** sonnet · **Effort:** S

### Evidence

Backlink excerpts insert matched text raw: `index/backlinks.go:328-329` (`sb.WriteString(matchedText)` — prefix/suffix *are* escaped, this isn't). FTS excerpts use SQLite `snippet()` which doesn't HTML-escape column text (`index/store.go:367`). The MCP comment claims the opposite: `mcp/tools.go:63-64` "the index escapes user content" — inaccurate. Browser consumers do sanitize (`BacklinksRail.tsx:180`, `SearchResultRow.tsx:128` via DOMPurify), so no live XSS.

### Attack scenario

A note containing `[[x</mark><img src=x onerror=...>]]` lands raw in `excerpt_html`; `search_notes` returns it raw to MCP clients. Neutralized today by DOMPurify, but the backend contract is "trust the client to sanitize" — a future consumer rendering `excerpt_html` without DOMPurify is XSS-vulnerable.

### Fix

HTML-escape `matchedText` in `buildExcerpt` (like prefix/suffix), and escape `snippet()` output before wrapping in `<mark>` (or build the snippet in Go with escaping). Correct the misleading `tools.go` comment.

---

## Verified secure (checked against code, not docs)

Preserved because a security-first app should record what holds:

- **Path traversal / vault escape is closed.** `fsstore.Canonicalize` rejects empty/absolute/`..` paths, then `EvalSymlinks`-resolves root and target and containment-checks with `filepath.Rel` (`canonicalize.go:43-111`), including new-file writes through a symlinked ancestor. All note-level MCP writes inherit it via `notes.Service`.
- **MCP ACL** is component-wise exact-match (a grant on `foo` does *not* match `foobar`), default-deny, `..`/absolute rejected; `move_note` requires Tier 2 on **both** source and destination and can't clobber (`acl.go:107-207`, `tools.go:407-412`).
- **No SQL injection** — every query in `index/*` and `mcp/acl.go` uses bound parameters, including the FTS `MATCH` and the LIKE fallback; tag names validated against `^[a-z0-9_-]+$`.
- **CSRF on mutations** — `csrfOriginMiddleware` enforces a fixed Origin allowlist on POST/PUT/DELETE; all genuine mutations are unsafe methods (verified in `openapi.yaml`). (Minor: the empty-Origin pass-through at `middleware.go:115-118` only benefits non-browser loopback clients — no-op risk.)
- **No CORS weakening** — no `Access-Control-Allow-Origin` anywhere; same-origin default preserved.
- **Stored XSS in rendered content** — DOMPurify config locked (`frontend/src/lib/sanitize.ts:13-21`: forbids script/iframe/object/embed/form + `on*`, `href/title/alt/src/class` only, no `javascript:`); only two `dangerouslySetInnerHTML` sites, both sanitized; CM6 widgets use `textContent`/`createElement`.
- **Security headers** — CSP (`script-src 'self'`), `Referrer-Policy: no-referrer`, nosniff, `X-Frame-Options: DENY` at both router roots.
- **No zip-slip / unbounded upload** — filenames stripped to `filepath.Base`, `.md` uploads rejected, 100 MB cap via `io.LimitReader`.
- **Reconcile** doesn't descend symlinked dirs (`filepath.WalkDir`); dotdirs/`attachments/` skipped.
- **Secrets/logging** — request logger records method/path/status only; no note content logged; grants in SQLite, no bearer tokens on disk.

---

## Priority order

1. **SEC-01 (HIGH)** — Host-allowlist middleware. Single highest-value control: also fixes SEC-02 and mostly SEC-06.
2. **SEC-02 (HIGH)** — covered by #1 + explicit WS Host check.
3. **SEC-03 (MEDIUM)** — remove filesystem mutation from GET `/daily-notes` (dovetails with SY-01).
4. **SEC-04 (MEDIUM)** — harden file serving (Content-Disposition / sandbox CSP; don't serve SVG inline).
5. **SEC-05 (MEDIUM)** — symlink parity: route file/attachment handlers through `fsstore.Canonicalize`.
6. **SEC-06 (LOW–MED)** — Host check on the MCP mux.
7. **SEC-07 (LOW)** — tighten data-dir/DB perms (resolve with OPS-05).
8. **SEC-08 (LOW)** — escape `excerpt_html` in the backend.

**GSD routing:** SEC-01/02 are the HIGH pair — given they're well-understood, either a fast `/gsd:debug` → fix or the H7 security phase in `GSD-INTAKE.md`. SEC-03..08 route through `/gsd:secure-phase`. SEC-07 merges with OPS-05's owner decision.

---

## Verification & testing notes (read before implementing — prior CSRF work hit test-harness friction)

The Origin/CSRF and Host-validation controls have a **known testing sharp edge**, and it is solvable — just at the right layer. A real browser controls the `Origin` and `Host` request headers and treats both as *forbidden headers* that page JavaScript cannot set. So an attack-path assertion driven from Playwright **page context** (`page.evaluate(fetch(...))`) cannot forge a cross-origin `Origin` or a rebound `Host` — the browser overwrites them with the legitimate loopback values, the request passes, and the test appears to "prove" nothing (or fails confusingly). This is almost certainly the friction the earlier CSRF change ran into.

Route the assertions by layer:

- **Attack-path (rejection) assertions → Go integration tests (`httptest`), not Playwright.** At the handler level you can set `Host: evil.com:6683` and `Origin: http://evil.com:6683` freely. This is the natural home for SEC-01 (Host reject), SEC-02 (WS upgrade with mismatched Host — also verifies the coder/websocket same-Host shortcut is closed), and the CSRF Origin-reject path. Cheap, deterministic, cross-platform.
- **Playwright's `request` API (APIRequestContext) can set `Origin`** (it bypasses the browser and uses its own HTTP client), so it *can* cover the CSRF Origin-reject path if you prefer E2E. But **`Host` override is unreliable** through that client (the underlying HTTP stack tends to reset it), so SEC-01/02 should stay at the Go layer.
- **Playwright page-context (real browser) → happy-path only.** Its job here is to confirm the app still works after the middleware lands: mutations from the legit loopback origin succeed, the WS connects, the SPA loads. It should *not* attempt to assert rejection.

**Net:** yes, these are fully testable — put the "does it block the attack" tests in Go integration, keep Playwright for "does the app still work." No E2E blocker. Note this in the H7 security phase's plan so the executor doesn't re-hit the wall.

### Cross-platform / WSL coverage this review touched

WSL was considered opportunistically, not as a dedicated parity pass (that remains an un-run angle — flag if you want it). Where it changed a finding it's captured: **SEC-07** (world-readable perms) explicitly calls out the WSL multi-user self-host case; **DUR-04** (`07-durability.md`) is a WSL-only data-loss bug whose regression test *must* run on a case-sensitive filesystem (Linux CI / `make test-wsl-e2e`), not the Mac dev loop; **DUR-01**'s watcher has an inotify-on-`/mnt/c` limitation documented there. The security controls themselves (Host allowlist, Origin, CSP, symlink resolution) behave identically on macOS and WSL — no platform-specific security gap found.
