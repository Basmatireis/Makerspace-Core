SHELL := /bin/sh

.DEFAULT_GOAL := help

.PHONY: help dev dev-detached dev-printer-connector dev-printer-connector-detached down logs db-up db-shell \
	migrate-up migrate-down migrate-status \
	generate generate-openapi-go generate-openapi-ts generate-sqlc \
	test test-backend test-frontend test-db test-integration test-e2e test-production-compose test-printer-connector-compose test-android test-desktop \
	check check-generated check-backend check-frontend build build-desktop admin bootstrap-master reset-password seed-dev

# Integration tests use their own database next to the development database so
# test runs never write into development data.
TEST_POSTGRES_DB ?= makerspace_test
# Rewrites the database name of the container's DATABASE_URL to TEST_POSTGRES_DB.
TEST_DATABASE_URL_EXPR = $$(printf %s "$$DATABASE_URL" | sed "s\#/[^/?]*?\#/$$TEST_POSTGRES_DB?\#")

help: ## Show available targets.
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "%-24s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

dev: ## Build and run the database, backend, and frontend with live source mounts.
	docker compose up --build

dev-detached: ## Start the development stack in the background.
	docker compose up --build -d

dev-printer-connector: ## Build and run the standalone printer connector for local development.
	docker compose -f printer-connector/compose.development.yaml up --build

dev-printer-connector-detached: ## Start the development printer connector in the background.
	docker compose -f printer-connector/compose.development.yaml up --build -d

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

test-printer-connector-compose: ## Package and validate the standalone printer-connector Compose bundle.
	./scripts/test-printer-connector-compose.sh

test-android: ## Build and unit-test the Android terminal in a pinned SDK container.
	./scripts/test-android-terminal.sh

test-desktop: ## Build the PC/SC sidecar and run Rust formatting, lint, and unit checks.
	cd desktop-terminal && pnpm install --frozen-lockfile
	cd desktop-terminal && pnpm check

test-db: db-up ## Create the dedicated integration-test database if missing and apply all migrations to it.
	docker compose exec -T db sh -c 'psql -U "$$POSTGRES_USER" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '\''$(TEST_POSTGRES_DB)'\''" | grep -q 1 || createdb -U "$$POSTGRES_USER" "$(TEST_POSTGRES_DB)"'
	docker compose run --rm --no-deps -e TEST_POSTGRES_DB=$(TEST_POSTGRES_DB) backend sh -c 'goose -dir migrations postgres "$(TEST_DATABASE_URL_EXPR)" up'

test-integration: test-db ## Run Go tests against the dedicated test database (never the development database).
	docker compose run --rm --no-deps -e APP_ENV=test -e TEST_POSTGRES_DB=$(TEST_POSTGRES_DB) backend sh -c 'TEST_DATABASE_URL="$(TEST_DATABASE_URL_EXPR)" go test -count=1 ./...'

seed-dev: migrate-up ## Add demo makerspace data to the development database (repeatable; SEED_ARGS="-seed 42 -actor-email ...").
	docker compose run --rm backend go run ./cmd/devseed $(SEED_ARGS)

.PHONY: test-migrations
test-migrations: ## Verify goose Up/Down/Up against an isolated empty database.
	sh ./scripts/test-migrations.sh

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

build: ## Build the backend, frontend, and printer connector production images.
	docker build --target final -f backend/Dockerfile .
	docker build --target final -f frontend/Dockerfile .
	docker build --target final -f printer-connector/Dockerfile .

build-desktop: ## Build the native desktop application and platform installer.
	cd desktop-terminal && pnpm install --frozen-lockfile
	cd desktop-terminal && pnpm build

admin: db-up ## Run the administrative CLI; pass non-secret arguments with ARGS='...'.
	docker compose --profile tools run --rm --build admin $(ARGS)

bootstrap-master: db-up ## Interactively create the first master account.
	docker compose --profile tools run --rm --build admin bootstrap-master

reset-password: db-up ## Interactively reset one existing Account's local password without changing Roles or status.
	docker compose --profile tools run --rm --build admin reset-password
