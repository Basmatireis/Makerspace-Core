#!/bin/sh

set -eu

e2e_project="makerspace-core-e2e-$$"
e2e_origin="http://127.0.0.1:55173"

export COMPOSE_PROJECT_NAME="$e2e_project"
export POSTGRES_PASSWORD="e2e-local-database-password"
export POSTGRES_PORT="55432"
export BACKEND_PORT="58080"
export FRONTEND_PORT="55173"
export PUBLIC_BASE_URL="$e2e_origin"
export APP_ENV="test"
export SESSION_COOKIE_SECURE="false"

cleanup() {
	docker compose down --volumes --remove-orphans
}
trap cleanup EXIT HUP INT TERM

docker compose up --detach --wait db
docker compose --profile tools run --rm --build migrate up
docker compose run --rm --no-deps --build backend go run ./tests/e2e/bootstrap
docker compose up --detach --build backend frontend

attempt=0
until curl --fail --silent --show-error "$e2e_origin" >/dev/null; do
	attempt=$((attempt + 1))
	if [ "$attempt" -ge 60 ]; then
		echo "Frontend did not become ready at $e2e_origin" >&2
		docker compose logs backend frontend >&2
		exit 1
	fi
	sleep 1
done

cd frontend
if [ -n "${PLAYWRIGHT_NODE_BINARY:-}" ]; then
	PLAYWRIGHT_BASE_URL="$e2e_origin" \
		PLAYWRIGHT_EXTERNAL_SERVER=true \
		PLAYWRIGHT_FULL_STACK=true \
		"$PLAYWRIGHT_NODE_BINARY" node_modules/@playwright/test/cli.js test
else
	PLAYWRIGHT_BASE_URL="$e2e_origin" \
		PLAYWRIGHT_EXTERNAL_SERVER=true \
		PLAYWRIGHT_FULL_STACK=true \
		pnpm exec playwright test
fi
