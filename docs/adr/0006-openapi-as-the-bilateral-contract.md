# ADR-0006 — OpenAPI 3.1 is the bilateral contract; both sides are generated

**Status:** Accepted (locked in `DESIGN.md` §2). **Amended 2026-10-04:** a second generated contract, the GraphQL SDL, for other systems. **Amended 2026-10-06:** its federation shape follows graphos ADR-0001.

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

## Amendment (2026-10-04) — a second contract, for other systems

OpenAPI stays the contract between Jasper's own frontend and backend. For **other systems** reading Jasper by id — a federation gateway, or a client with none — there is a second contract: the GraphQL SDL at `api/graphql/schema.graphqls`, served at `/graphql` on the main listener as an Apollo Federation 2.3 subgraph.

The same discipline applies to both. The SDL is the source of truth; `gqlgen` (v0.17.94, pinned because v0.17.95 needs Go 1.26) generates the executable schema, the models and the resolver stubs under `backend/internal/graphql/`; the generated files are committed and `make gen-check` fails on any drift. Edit the schema first, run `make gen`, commit both.

Decisions recorded with it:

- **Reads only.** `item`, `items`, `backlinks`, `searchItems` and the `itemChanged` subscription. Writes stay on REST (the frontend) and MCP (agents), which accept the same ids. Mutations arrive when a consumer needs them.
- **`body` has no gate.** MCP reads are already global ([ADR-0013](./0013-mcp-always-on-grant-gated.md)); a read gate that exists in one surface and not the other would be no gate.
- **`Item` is a value interface.** Apollo Federation 2.3 lets only one subgraph declare an interface carrying `@key`, and that subgraph must then define every implementation; `@apollo/composition` confirmed that two subgraphs each declaring `interface Item @key` fail to compose. So `Item` carries no key, each subgraph keys its own concrete types and implements `Item` on them, and cross-system lookup goes through `Query.item`, routed by a ref's namespace. `make compose-check` composes the subgraph with stub `ado:` and `bt:` subgraphs under `api/graphql/stubs/`. *(The lookup, the root field names and the composition check are superseded by the 2026-10-06 amendment.)*
- **Same port, POST and websocket only.** `/graphql` sits behind the CSRF origin middleware like every other route. There is no GET transport, so a cross-site `<img>` or link cannot run a query; the subscription runs over `graphql-transport-ws` with the websocket accept checking Origin against the loopback hosts.
- **One event source.** The subscription is a tee on the service's `Broadcaster`: every broadcast goes to the browser hub first and then to subscribers, so the two audiences never disagree about what happened.
- **Cost.** With `CGO_ENABLED=0`, the binary grows from 30.4 MB to 32.4 MB. `gqlgen` adds no CGo and uses the `coder/websocket` Jasper already ships (bumped 1.8.14 → 1.8.15).

## Amendment (2026-10-06) — the shell routes ids; Jasper's root fields are namespaced

The 2026-10-04 amendment assumed every subgraph would serve `item(id)` and a gateway would route it by namespace. A composition spike in the graphos repo showed the router does no such thing: a root field shared by several subgraphs is served by one of them, never unioned or fanned out. The outcome is recorded in graphos [ADR-0001](../../../graphos/docs/adr/0001-item-is-a-value-interface-and-the-shell-routes-ids.md), and Jasper takes the shape it fixes:

- **The shell subgraph owns the supergraph's `item(id)` and `items(ids)`.** It maps an id's kind to a type and returns an entity stub; the router hydrates it from Jasper through `_entities`. Jasper never routes.
- **Jasper's root fields are `jasperItem`, `jasperItems`, `jasperBacklinks` and `jasperSearch`.** Unprefixed names would collide with the shell's. `jasperBacklinks` and `jasperSearch` return nullable lists: under GraphQL null propagation, a non-null root field that errors nulls the whole response, so a failing Jasper would blank the shell's search instead of only its own field. `itemChanged` is unchanged.
- **The shared declarations come from graphos verbatim.** `Item`, `ItemStatus`, `ItemKind`, `DateTime`, the shape interfaces (`Timed`, `Stateful`, `Linkable`, `Actionable`) and `Action` are copied from `graphos/schema/item.graphql`; Jasper adds `NOTE` and `BLOB` with `extend enum`. `Action` and `ForeignRef` are `@shareable` because other subgraphs define them too. A value interface merges across subgraphs, so a definition that drifts stops the supergraph composing.
- **Graphos's SDL is vendored, not fetched.** `api/graphql/graphos/` holds `item.graphql` and the shell subgraph's SDL, with the graphos commit they came from; `make vendor-graphos` refreshes them. A test holds Jasper's shared block to the vendored copy, and `make compose-check` composes Jasper with the shell through `composition-go`, the composer graphos's gateway uses. A cross-repo checkout in CI was the alternative; vendoring keeps the check offline and free of cross-repo credentials, at the cost of noticing graphos changes only on a refresh.
