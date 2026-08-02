.PHONY: gen gen-check build test lint dev gen-go gen-ts print-port perf-check perf-vault test-systemd-e2e

# Canonical port resolver. Returns server.port from
# the active vault's <vault>/.jasper/config.json (or $JASPER_CONFIG),
# or 6683 if no config exists. Used by .air.toml, vite.config.ts,
# Playwright, and perf-check.
print-port:
	@./scripts/port.sh

# 5k-note startup gate. Requires bin/jasper (run
# `make build` first). _perf-vault/ is populated by 08-14's
# `make perf-vault`; absent that, this still runs as a smoke check
# but is not a real startup gate.
perf-check:
	@./scripts/perf-check.sh

# Generate a deterministic 5k-note synthetic
# vault under _perf-vault/notes/ for the cold-start gate.
# Distribution: 80% body-only, 15% tagged, 5% wiki-link.
# Full pipeline: `make build && make perf-vault && make perf-check`.
# _perf-vault/ is .gitignored — local-only artifact.
perf-vault:
	@rm -rf _perf-vault
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

# Docker-as-fake-WSL e2e: builds the Linux jasper binary inside a container
# with a fake /proc/sys/kernel/osrelease ("microsoft"), brings the bridge up,
# runs the WSL parity Playwright spec, tears down regardless of outcome.
# See compose/wsl-validation/README in the Dockerfile header for the design.
.PHONY: test-wsl-e2e
test-wsl-e2e:
	@echo "==> Building wsl-validation image + bringing up container"
	@# frontend/dist/ must exist before the Dockerfile COPY step runs.
	@# Build it host-side via the standard Vite pipeline; it's cheap if
	@# already current.
	cd frontend && npm install && npm run build
	docker compose -f compose/wsl-validation/docker-compose.yml up \
	  --build --detach --wait
	@echo "==> Running Playwright fake-WSL spec"
	@# Wait flag above blocks until healthcheck passes; the spec then
	@# connects to the published host port. Tear down on success OR failure.
	@trap 'docker compose -f compose/wsl-validation/docker-compose.yml down -v --remove-orphans' EXIT; \
	  cd frontend && JASPER_WSL_HOST_PORT=$${JASPER_WSL_HOST_PORT:-6684} \
	    npx playwright test -c playwright.wsl.config.ts

# One-command harness for the systemd
# install-validation suite (compose/install-validation/).
# CROSS-compiles a linux/amd64 binary (NOT the host-native `build` target):
# the compose suite mounts bin/ into a `platform: linux/amd64` container, so a
# host-native macOS/arm64 Mach-O binary would fail with an exec-format error on
# the macOS-first dev platform. Pure-Go SQLite (no CGo) cross-compiles cleanly
# with CGO_ENABLED=0. The frontend embed steps mirror `build` (static assets
# are platform-independent). Then delegates to compose/install-validation/run.sh
# for: up → wait-systemd → exec test-install.sh → down (trap-guarded on success
# AND failure).
#
# DISTINCT from test-wsl-e2e, which drives the unrelated Alpine wsl-validation
# harness (compose/wsl-validation/). Do NOT conflate the two suites.
#
# The CI job (.github/workflows/install-validation.yml) calls this target
# directly so it cannot list divergent compose commands — zero drift.
.PHONY: test-systemd-e2e
test-systemd-e2e:
	cd frontend && npm install && npm run build
	rm -rf backend/internal/static/dist
	mkdir -p backend/internal/static/dist
	cp -R frontend/dist/. backend/internal/static/dist/
	touch backend/internal/static/dist/.keep
	cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ../bin/jasper ./cmd/jasper
	@bash compose/install-validation/run.sh
