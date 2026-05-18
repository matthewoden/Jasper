.PHONY: gen gen-check build test lint dev gen-go gen-ts print-port perf-check perf-vault

# Phase 8 D-40: canonical port resolver. Returns server.port from
# ~/.jasper/storage/config.json (or $JASPER_CONFIG), or 6683 if no
# config exists. Used by .air.toml, vite.config.ts, Playwright, and
# perf-check.
print-port:
	@./scripts/port.sh

# Phase 8 PERF-01: 5k-note startup gate. Requires bin/jasper (run
# `make build` first). _perf-vault/ is populated by 08-14's
# `make perf-vault`; absent that, this still runs as a smoke check
# but is not a real PERF-01 gate.
perf-check:
	@./scripts/perf-check.sh

# Phase 8 Plan 08-14 / D-42: generate a deterministic 5k-note synthetic
# vault under _perf-vault/notes/ for the PERF-01 cold-start gate.
# Distribution: 80% body-only, 15% tagged, 5% wiki-link.
# Full pipeline: `make build && make perf-vault && make perf-check`.
# _perf-vault/ is .gitignored — local-only artifact.
perf-vault:
	@bash scripts/generate-perf-vault.sh _perf-vault 5000

gen: gen-go gen-ts

gen-go:
	cd backend && go generate ./...

gen-ts:
	cd frontend && npx openapi-typescript ../api/openapi.yaml -o src/api/schema.d.ts

gen-check: gen
	git diff --exit-code -- backend/internal/api/openapi_gen.go frontend/src/api/schema.d.ts || \
	  (echo "ERROR: generated artifacts drift from api/openapi.yaml. Run 'make gen' and commit." && exit 1)

build:
	cd frontend && npm install && npm run build
	rm -rf backend/internal/static/dist
	mkdir -p backend/internal/static/dist
	cp -R frontend/dist/. backend/internal/static/dist/
	# Recreate .keep so a subsequent fresh checkout (or `git clean -dxf`
	# followed by reset) keeps //go:embed all:dist compiling without
	# requiring a build first. The .gitignore allowlist `!backend/internal/static/dist/.keep`
	# protects this file from being treated as a build artifact.
	touch backend/internal/static/dist/.keep
	cd backend && go build -o ../bin/jasper ./cmd/jasper

test:
	cd backend && go test ./...
	cd frontend && npm test -- --run

lint:
	cd backend && golangci-lint run ./...
	cd frontend && npx eslint .

dev:
	cd frontend && npx concurrently --kill-others --names BACKEND,FRONTEND --prefix-colors blue,magenta \
	  "cd .. && go tool air" \
	  "npm run dev"
