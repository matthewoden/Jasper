// Package api hosts the OpenAPI-generated server stubs and the handler
// implementations that satisfy them. Generation is driven by:
//
//	//go:generate go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen --config=cfg.yaml ../../../api/openapi.yaml
//
// Run via `make gen` from the repo root. The generated file
// (openapi_gen.go) is committed; CI / lefthook enforce
// `make gen-check` (gen + git diff --exit-code) so the spec and the
// Go interface cannot drift (API-04).
package api

//go:generate go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen --config=cfg.yaml ../../../api/openapi.yaml
