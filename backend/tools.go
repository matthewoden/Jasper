//go:build tools

// Package tools tracks build-time tool dependencies that have no runtime
// import path in the rest of the codebase. The build constraint above
// excludes this file from regular builds so the imported `main` packages
// don't try to link.
//
// `go mod tidy` keeps these deps in go.sum so `go run` and `go generate`
// can resolve them deterministically. Pattern documented in:
//   https://github.com/golang/go/wiki/Modules#how-can-i-track-tool-dependencies-for-a-module
package tools

import (
	// oapi-codegen produces backend/internal/api/openapi_gen.go via
	// the //go:generate directive in backend/internal/api/gen.go.
	_ "github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen"
)
