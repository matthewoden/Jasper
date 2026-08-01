# ADR-0006 — OpenAPI 3.1 is the bilateral contract; both sides are generated

**Status:** Accepted (locked in `DESIGN.md` §2)

## Context

A Go backend and a TypeScript frontend need to agree on every request and response shape. The usual failure is drift: a handler changes, the client's hand-written types don't, and the mismatch surfaces at runtime in the browser.

## Decision

`api/openapi.yaml` is the single source of truth. Both sides are generated from it:

- **Backend** — `oapi-codegen` v2.7 emits `backend/internal/api/openapi_gen.go` (a `StrictServerInterface` plus request/response types) via `go generate`.
- **Frontend** — `openapi-typescript` v7 emits `frontend/src/api/schema.d.ts`; `openapi-fetch` consumes it for typed calls.

`make gen-check` regenerates both and fails on any diff. It runs in CI and in the pre-commit hook.

Workflow for any API change: **edit the spec first**, run `make gen`, then commit the spec and both generated artifacts together.

## Rationale

`oapi-codegen` was chosen over `ogen` for a gentler learning curve and sufficiency for this API's surface area.

The strict-server interface is the load-bearing part: it will not compile until every declared route has an implementation. The contract can't rot silently on the Go side, and `gen-check` stops it rotting on the TypeScript side.

## Consequences

- Over five weeks of v1.0 development, `gen-check` caught every drift. This was assessed in retrospective as **the single biggest force multiplier in the codebase**.
- Adding a route is a three-file change minimum (spec + regenerated Go + regenerated TS). This friction is the point.
- A missed regeneration is a hard CI failure, not a runtime surprise.
- Adding a config field means updating `api/openapi.yaml`, the `config.Config` struct, *and* the strict config validator in the same commit — otherwise `PUT /config` starts returning 400 with no obvious cause.
