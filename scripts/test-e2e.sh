#!/bin/sh

set -eu

e2e_project="makerspace-core-e2e-$$"
e2e_origin="http://127.0.0.1:55173"

export COMPOSE_PROJECT_NAME="$e2e_project"
export POSTGRES_PASSWORD="e2e-local-database-password"
export POSTGRES_PORT="${E2E_POSTGRES_PORT:-55432}"
export BACKEND_PORT="58080"
export FRONTEND_PORT="55173"
export PUBLIC_BASE_URL="$e2e_origin"
export APP_ENV="test"
export SESSION_COOKIE_SECURE="false"
# The dev server serves every page of the suite from one process; a larger heap keeps it from dying mid-run.
export FRONTEND_NODE_OPTIONS="${FRONTEND_NODE_OPTIONS:---max-old-space-size=4096}"

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

# PLAYWRIGHT_SHARD ("current/total", set by CI) runs one slice of the specs against this stack.
shard_args=""
if [ -n "${PLAYWRIGHT_SHARD:-}" ]; then
	shard_args="--shard=${PLAYWRIGHT_SHARD}"
fi

cd frontend
set +e
if [ -n "${PLAYWRIGHT_NODE_BINARY:-}" ]; then
	PLAYWRIGHT_BASE_URL="$e2e_origin" \
		PLAYWRIGHT_EXTERNAL_SERVER=true \
		PLAYWRIGHT_FULL_STACK=true \
		"$PLAYWRIGHT_NODE_BINARY" node_modules/@playwright/test/cli.js test $shard_args
else
	PLAYWRIGHT_BASE_URL="$e2e_origin" \
		PLAYWRIGHT_EXTERNAL_SERVER=true \
		PLAYWRIGHT_FULL_STACK=true \
		pnpm exec playwright test $shard_args
fi
status=$?
set -e
if [ "$status" -ne 0 ]; then
	# The stack's own logs say whether a page failed or the server behind it went away.
	docker compose logs --tail=300 backend frontend >&2
fi
exit "$status"
