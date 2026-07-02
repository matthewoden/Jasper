# 02 — Multi-Session Sync and the Event Contract

The sync architecture is push-only with no gap repair, and two of the three write surfaces don't push consistently. The findings interlock with 01-data-integrity: SY-02 is *how* events get lost, DI-03 is *what makes lost events destructive*, SY-01/SY-03 are events that *never existed*.

---

## SY-01 — Mutation paths that never broadcast: daily-note create, /files upload/delete/move, attachment upload

**Priority:** HIGH · **Executor:** sonnet · **Effort:** M

### Evidence

- `backend/internal/api/daily.go:69-113` — the create branch of `GetDailyNote` bypasses `notes.Service` entirely: direct `os.MkdirAll` + `fsstore.AtomicWrite` + `s.index.Upsert` + `s.index.SyncTags` + `s.notes.Registry().Add(...)` — despite `service.go:72-74` explicitly saying production callers must not use the `Registry()` accessor. Zero `Broadcast` calls in the file. It also skips the service's case-collision check, frontmatter canonicalization, `SyncBacklinks` for template content, the title index (daily notes unresolvable as `[[2026-07-01]]`), and inherits the DI-01 FTS gap.
- `backend/internal/api/files.go` — `CreateFile` (:101), `DeleteFile` (:269), `PostFileMove` (:304): no `Broadcast` calls, yet these files appear in the tree as `FileNode` (`openapi.yaml:1818-1842`).
- `backend/internal/api/attachments.go` — no broadcast on upload.
- Client side has nothing to ride on: `frontend/src/lib/useSessionSync.ts:134-139` refreshes the tree only on `note:*` / `folder:*` events.

### Failure scenario

Tab A opens today's daily note (created on the fly) or drops a PNG into a folder; Tab B's tree never shows it — not stale-for-seconds, stale *forever* until an unrelated mutation or manual reindex. Other tabs never see the daily note either (violates the SYNC contract every other mutation honors).

### Fix

1. **Daily note:** add `Service.GetOrCreateDailyNote(ctx, date, template) (Note, created bool, error)` in `internal/notes`, composing the existing `CreateWithBodyAndTitle` (`service.go:269` — it already broadcasts `note:created` and maintains registry/FTS/backlinks). The handler shrinks to translate-request/translate-response like `GetNoteById` (`handlers.go:142`). This single change fixes broadcast, collision-check, title-index, backlinks, and FTS for daily notes at once.
2. **Files/attachments:** add `file:created` / `file:deleted` / `file:moved` to the `WSEnvelope.event` enum + payload schemas in `api/openapi.yaml`, broadcast from the three `/files` handlers and attachment upload (the broadcaster is already injected into `api.Server`), and add the three events to the `refreshTree` case group in `useSessionSync.ts`.

### Done when

Two-session E2E: session A creates the daily note / uploads a file; session B's tree updates without manual refresh. Go test: `GetDailyNote` create branch emits `note:created` and the note is body-searchable and `[[date]]`-resolvable.

---

## SY-02 — Reconnect refreshes the tree only; missed WS events are unrecoverable

**Priority:** HIGH · **Executor:** sonnet (refetch-barrier version; opus if bundled with DI-03) · **Effort:** M

### Evidence

- `frontend/src/lib/useSessionSync.ts:93-104` — `ws.onopen` does exactly one thing: `await refreshTree()`.
- No sequence numbers in `wshub.Envelope` (`envelope.go:43-47`) — gaps are undetectable. Server drops slow clients after a 64-message buffer (`wshub/client.go:11`, `hub.go:122-127`) and relies on this same partial resync.
- Consequences of a gap: a clean-but-stale open editor keeps stale content forever (`EditorPane.tsx:525-547` only refetches when the event *arrives*); a note deleted during the gap never gets `markDeleted` on its tab (`App.tsx:277-283`); tags/backlinks/grants panels have the same hole (their dispatch buses only fire on live events).
- Vault-swap compounds it: `vault.switched` is broadcast once after teardown + full new-vault boot (`lifecycle_vault_swap.go:116`); a tab disconnected across the whole swap window misses both events, reconnects to the new vault's hub, and `refreshTree()` renders vault-B's tree under vault-A's open tabs and note IDs.
- During the swap window, REST returns plain-text `"no handler"` 503 (`app/swappable_handler.go:33`) — not the spec's `Error` schema; no production frontend code handles 503.

### Failure scenario

Laptop sleeps mid-session → wake → editor shows stale content (DI-03 then makes it destructive). Or sleeps across a vault switch → mixed-vault UI state and 404s.

### Fix

Make reconnect a full revalidation barrier in `useSessionSync.onopen`, gated on `attempt > 0` (reconnect, not first connect):

1. Re-fetch `/vault/current` first; if the vault path changed, hard-reload (reuse the `vault.switched` handling).
2. `await refreshTree()` (existing).
3. Fan out a `revalidate()` to every open editor pane: refetch the note when `!userHasEdited`; when edited, route through the DI-03 If-Match path (which surfaces the banner instead of clobbering).
4. Fire `dispatchTagEvent`, `dispatchLinksEvent`, `dispatchMcpGrantsEvent` (one-liners).
5. Make `swappableHandler`'s nil response a JSON `{"code":"vault_switch_in_progress"}` 503 matching the spec's error contract.

A seq-number/replay protocol was considered and rejected as overkill for a single-user app — full refetch-on-reconnect is the right size. (FE-06's event-bus consolidation makes step 4 automatic; do that first if scheduling allows.)

### Done when

E2E: open note in two sessions; sever B's WS (kill the socket, not the server); mutate via A (edit + delete another open note); restore B → B's editor content refreshes, deleted note's tab is marked, tag panel refreshes.

---

## SY-03 — MCP `move_note` silently breaks wiki-links: LINKS-07 rewrite lives in the REST handler, not the service

**Priority:** HIGH · **Executor:** opus · **Effort:** M

### Evidence

- REST side: `backend/internal/api/notes_handlers.go:166-170` — `PostNoteMove` calls `s.notes.Move(...)`, then **in the handler** runs `s.notes.RenameRewriteWikilinks(ctx, oldTitle, newTitle)` with rollback-on-failure and a `links:rewritten` broadcast (`notes_handlers.go:185`).
- MCP side: `backend/internal/mcp/tools.go:417` — `move_note` calls `s.notesSvc.Move(ctx, id, args.NewPath)` and returns. No title diff, no rewrite, no `links:rewritten`.

### Failure scenario

Claude renames `ideas.md` → `roadmap.md` via MCP: every `[[ideas]]` reference in the vault dangles, and no client is told to refresh backlinks. The same rename in the UI rewrites all references. The two write surfaces produce **different vault states for the same operation** — exactly the divergence the shared-service architecture exists to prevent.

### Fix

Move the rename-rewrite orchestration (title diff → `RenameRewriteWikilinks` → rollback → `links:rewritten` broadcast) from `PostNoteMove` into `notes.Service.Move` (or a `Service.MoveWithRewrite` that both surfaces call). `PostNoteMove` becomes a thin mapper. Side benefit: kills the fabricated `UpdatedAt: time.Now()` on the rollback path (`notes_handlers.go:194` — see DI-04). Rollback semantics and broadcast ordering cross a layer boundary here, which is why this is opus-tier; tests needed on both surfaces.

### Done when

Test on each surface: rename a note that is `[[linked]]` from two others via REST *and* via MCP → all referring notes rewritten, `links:rewritten` broadcast observed, rollback path leaves the vault unchanged on injected failure.

---

## SY-04 — `WSEnvelope.payload` is untyped in the spec; hand-built and hand-cast on both ends; drift has already shipped

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** M

### Evidence

- `api/openapi.yaml:2253-2254` — `payload:` has no type; the `WS*Payload` schemas exist (`:2255-2317`) but nothing binds event name → payload schema. Missing schemas entirely: `vault.switching`, `vault.switched`, `mcp:grant_changed`, `tags:updated`, `session:assigned`, `migration:status`.
- Backend: every broadcast is a hand-shaped `map[string]any` (`notes/service.go:227-231`, `lifecycle_vault_swap.go:72-75`) — the generated `api.WS*Payload` structs are never used. The only drift guard is the compile-time sentinel on the *envelope* (`wshub/envelope.go:32`).
- Frontend: unchecked casts at every arm (`useSessionSync.ts:120-121,127,145,159`); the `vault.switching` payload type is hand-written inline (`useSessionSync.ts:165-168`).
- **Drift has already half-happened:** `vault.switching` uses `target_path` while `vault.switched` uses `path` (`lifecycle_vault_swap.go:73` vs `:120`).
- `migration:status` is in the enum (`openapi.yaml:2241`) with zero broadcast sites and no client case — a dead contract entry (client polls `GET /admin/status` instead).

### Failure scenario

Backend renames a payload key — compiles clean, typechecks clean, ships; every tab's overlay silently gets `undefined`. The WS channel is the highest-drift boundary in the system (Go const block + YAML enum + TS switch, maintained in triplicate) and it's exactly where the generated types stop helping.

### Fix

1. Model the envelope as a discriminated union in the spec: `oneOf` of per-event envelope variants with `discriminator: { propertyName: event }` and typed `payload` each (add the six missing payload schemas; openapi-typescript emits a proper discriminated union from this).
2. Backend broadcasts construct the generated payload structs (Hub already accepts `any`).
3. Frontend: replace the casts with union narrowing on `event` — adding an event without a payload schema then becomes a `make gen-check` failure instead of a runtime surprise.
4. Remove `migration:status` from the enum or implement it. Unify `target_path` vs `path`.
5. Verify oapi-codegen still compiles the oneOf on the Go side before committing (known sharp edge with discriminators — if it fights, keep the Go side on plain structs and only tighten the TS side).

### Done when

`make gen-check` passes; zero `as WS*Payload` casts remain in `useSessionSync.ts`; a payload-key rename breaks the frontend build.

---

## SY-05 — MCP `update_note` misdocuments omitted `if_match` as safe and misreports `force_write`

**Priority:** MEDIUM · **Executor:** sonnet · **Effort:** S

### Evidence

- `backend/internal/mcp/tools.go:349-353` — tool description: *"Omitting if_match is equivalent to passing the result of read_note immediately prior."* It is not: `tools.go:375-380` maps omitted `if_match` to `""`, which `service.go:141` treats as *skip the check entirely* — unguarded last-writer-wins.
- The response then reports `ForceWrite: false` (`tools.go:397`), which is supposed to be reserved for the explicit `"*"` escape hatch. The arg is `omitempty` (`tools.go:110`).

### Failure scenario

An LLM — the literal consumer of this description — omits `if_match` believing it's safe and overwrites a note the user edited between the model's read and write, with the audit trail showing `force_write=false`.

### Fix

1. Make `if_match` required in `UpdateNoteArgs` (jsonschema `required`); reject empty with a `missing_if_match` error instructing the model to call `read_note` first.
2. Keep `"*"` as the only escape hatch, and set `ForceWrite: true` for it alone.
3. Rewrite the tool description to match actual semantics.

### Done when

MCP test: `update_note` without `if_match` returns the instructive error; with stale `if_match` returns the conflict shape; with `"*"` succeeds and reports `force_write: true`.
