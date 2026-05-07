.PHONY: gen gen-check build test lint dev gen-go gen-ts

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
	cd backend && go build -o ../bin/jasper ./cmd/jasper

test:
	cd backend && go test ./...
	cd frontend && npm test -- --run

lint:
	cd backend && golangci-lint run ./...
	cd frontend && npx eslint .

dev:
	cd frontend && npx concurrently --kill-others --names BACKEND,FRONTEND --prefix-colors blue,magenta \
	  "cd ../backend && go tool air" \
	  "npm run dev"
