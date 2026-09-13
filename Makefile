SHELL := /bin/sh

.DEFAULT_GOAL := help

.PHONY: help dev dev-detached down logs db-up db-shell \
	migrate-up migrate-down migrate-status \
	generate generate-openapi-go generate-openapi-ts generate-sqlc \
	test test-backend test-frontend test-integration test-e2e test-production-compose \
	check check-generated check-backend check-frontend build admin bootstrap-master

help: ## Show available targets.
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "%-24s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

dev: ## Build and run the database, backend, and frontend with live source mounts.
	docker compose up --build

dev-detached: ## Start the development stack in the background.
	docker compose up --build -d

down: ## Stop the development stack without deleting database data.
	docker compose down

logs: ## Follow application logs.
	docker compose logs --follow backend frontend

db-up: ## Start PostgreSQL and wait for its health check.
	docker compose up -d --wait db

db-shell: ## Open psql inside the PostgreSQL container.
	docker compose exec db sh -c 'exec psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'

migrate-up: db-up ## Apply all pending goose migrations explicitly.
	docker compose --profile tools run --rm --build migrate up

migrate-down: db-up ## Revert the most recent goose migration.
	docker compose --profile tools run --rm --build migrate down

migrate-status: db-up ## Show goose migration status.
	docker compose --profile tools run --rm --build migrate status

generate: generate-openapi-go generate-openapi-ts generate-sqlc ## Regenerate all committed API and database bindings.

generate-openapi-go: ## Regenerate Go transport types and strict Chi server interfaces.
	docker compose run --rm --no-deps backend oapi-codegen --config oapi-codegen.yaml ../api/openapi.yaml

generate-openapi-ts: ## Regenerate the Orval fetch client and TypeScript API types.
	docker compose run --rm --no-deps -e CI=true frontend pnpm generate:api

generate-sqlc: ## Regenerate sqlc repository bindings.
	docker compose run --rm --no-deps backend sqlc generate

test: test-backend test-frontend ## Run unit-level backend and frontend tests.

test-backend: ## Run Go tests.
	docker compose run --rm --no-deps backend go test ./...

test-frontend: ## Run frontend tests.
	docker compose run --rm --no-deps -e CI=true frontend pnpm test

test-e2e: ## Run all Playwright checks against an isolated live Go/PostgreSQL stack.
	./scripts/test-e2e.sh

test-production-compose: ## Smoke-test the standalone production Compose release bundle.
	./scripts/test-production-compose.sh

test-integration: migrate-up ## Run Go tests against the Compose PostgreSQL instance.
	docker compose run --rm -e APP_ENV=test backend sh -c 'TEST_DATABASE_URL="$$DATABASE_URL" go test -count=1 ./...'

check: check-generated check-backend check-frontend ## Regenerate, verify freshness, and run all static/unit checks.

check-generated: ## Regenerate committed bindings and fail when generated files are stale.
	./scripts/check-generated.sh

check-backend: ## Run Go vet and tests.
	docker compose run --rm --no-deps backend sh -c 'files="$$(gofmt -l .)"; test -z "$$files" || { echo "$$files"; exit 1; }'
	docker compose run --rm --no-deps backend go vet ./...
	docker compose run --rm --no-deps backend go test ./...

check-frontend: ## Run lint, type checking, tests, and a production build.
	docker compose run --rm --no-deps -e CI=true frontend pnpm lint
	docker compose run --rm --no-deps -e CI=true frontend pnpm typecheck
	docker compose run --rm --no-deps -e CI=true frontend pnpm test
	docker compose run --rm --no-deps -e CI=true frontend pnpm build

build: ## Build the backend and frontend production images.
	docker build --target final -f backend/Dockerfile .
	docker build --target final -f frontend/Dockerfile .

admin: db-up ## Run the administrative CLI; pass non-secret arguments with ARGS='...'.
	docker compose --profile tools run --rm --build admin $(ARGS)

bootstrap-master: db-up ## Interactively create the first master account.
	docker compose --profile tools run --rm --build admin bootstrap-master
