#!/bin/sh

set -eu

export COMPOSE_PROJECT_NAME="makerspace-core-migrations-$$"
export POSTGRES_PASSWORD="migration-test-local-password"
export POSTGRES_PORT=0

cleanup() {
	docker compose down --volumes --remove-orphans
}
trap cleanup EXIT HUP INT TERM

# This project owns a fresh, disposable database. Never roll back a developer's
# or deployed database just to check migration syntax and ordering.
docker compose up --detach --wait db
docker compose run --rm --no-deps backend sh -c '
    goose -dir migrations postgres "$DATABASE_URL" up &&
    goose -dir migrations postgres "$DATABASE_URL" down-to 0 &&
    goose -dir migrations postgres "$DATABASE_URL" up
'
