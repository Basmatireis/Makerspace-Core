#!/bin/sh

set -eu

repository_directory=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
smoke_id=$$
image_prefix="makerspace-core-production-smoke-$smoke_id"
image_version=0.0.0
backend_image="$image_prefix-backend:$image_version"
frontend_image="$image_prefix-frontend:$image_version"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/makerspace-core-production-smoke.XXXXXX")
deployment_directory="$temporary_directory/deployment"

export COMPOSE_PROJECT_NAME="makerspace-core-production-smoke-$smoke_id"
export MAKERSPACE_IMAGE_PREFIX="$image_prefix"
export PUBLIC_BASE_URL=https://makerspace.example.test
export FRONTEND_BIND_ADDRESS=127.0.0.1
export FRONTEND_PORT=0
export POSTGRES_DB=makerspace
export POSTGRES_USER=makerspace
export POSTGRES_PASSWORD=production-smoke-password
export OTEL_SDK_DISABLED=true

compose() {
    (cd "$deployment_directory" && docker compose "$@")
}

cleanup() {
    status=$?
    trap - EXIT INT TERM
    if [ -f "$deployment_directory/compose.yaml" ]; then
        if [ "$status" -ne 0 ]; then
            compose logs --no-color || true
        fi
        compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    fi
    docker image rm "$backend_image" "$frontend_image" >/dev/null 2>&1 || true
    rm -rf "$temporary_directory"
    exit "$status"
}

wait_for_url() {
    url=$1
    attempts=0
    until curl --fail --silent --show-error --output /dev/null "$url"; do
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 30 ]; then
            return 1
        fi
        sleep 1
    done
}

trap cleanup EXIT INT TERM

cd "$repository_directory"

docker build --target final --tag "$backend_image" --file backend/Dockerfile .
docker build --target final --tag "$frontend_image" --file frontend/Dockerfile .

archive_path=$(./scripts/package-production-compose.sh "$image_version" "$temporary_directory")
archive_entries=$(tar -tzf "$archive_path" | sort)
expected_entries=$(printf '%s\n' .env.example compose.yaml)
test "$archive_entries" = "$expected_entries"

mkdir "$deployment_directory"
tar -xzf "$archive_path" -C "$deployment_directory"
test "$(grep -c ":$image_version" "$deployment_directory/compose.yaml")" = 2
test -z "$(grep -F '__MAKERSPACE_VERSION__' "$deployment_directory/compose.yaml" || true)"

compose config --quiet
services=$(compose config --services)
test "$(printf '%s\n' "$services" | wc -l | tr -d ' ')" = 3
printf '%s\n' "$services" | grep -Fx db >/dev/null
printf '%s\n' "$services" | grep -Fx backend >/dev/null
printf '%s\n' "$services" | grep -Fx frontend >/dev/null

# This is the complete production startup command documented for operators.
compose up -d

running_services=$(compose ps --status running --services)
test "$(printf '%s\n' "$running_services" | wc -l | tr -d ' ')" = 3
printf '%s\n' "$running_services" | grep -Fx db >/dev/null
printf '%s\n' "$running_services" | grep -Fx backend >/dev/null
printf '%s\n' "$running_services" | grep -Fx frontend >/dev/null

db_container=$(compose ps --quiet db)
backend_container=$(compose ps --quiet backend)
frontend_container=$(compose ps --quiet frontend)
db_binding=$(docker inspect --format '{{with index .NetworkSettings.Ports "5432/tcp"}}{{(index . 0).HostIp}}:{{(index . 0).HostPort}}{{end}}' "$db_container")
backend_binding=$(docker inspect --format '{{with index .NetworkSettings.Ports "8080/tcp"}}{{(index . 0).HostIp}}:{{(index . 0).HostPort}}{{end}}' "$backend_container")
frontend_binding=$(docker inspect --format '{{with index .NetworkSettings.Ports "8080/tcp"}}{{(index . 0).HostIp}}:{{(index . 0).HostPort}}{{end}}' "$frontend_container")
test -z "$db_binding"
test -z "$backend_binding"
case "$frontend_binding" in
    127.0.0.1:*) ;;
    *)
        printf 'unexpected frontend binding: %s\n' "$frontend_binding" >&2
        exit 1
        ;;
esac

frontend_url="http://$frontend_binding"
wait_for_url "$frontend_url/"
ready_response=$(curl --fail --silent --show-error "$frontend_url/api/v1/health/ready")
test "$ready_response" = '{"status":"ok"}'

# Starting the already-migrated deployment again must remain safe.
compose up -d
test "$(compose ps --status running --services | wc -l | tr -d ' ')" = 3

# NGINX resolves the Compose service name dynamically, so replacing the API
# container must not require replacing or restarting the frontend container.
compose up --detach --wait --no-deps --force-recreate backend
wait_for_url "$frontend_url/api/v1/health/ready"

compose down --volumes --remove-orphans

# A failed migration must prevent the API and frontend from starting.
export COMPOSE_PROJECT_NAME="makerspace-core-production-smoke-failure-$smoke_id"
cat >"$deployment_directory/compose.override.yaml" <<'YAML'
services:
  backend:
    environment:
      GOOSE_DBSTRING: postgres://makerspace@127.0.0.1:1/makerspace?sslmode=disable&connect_timeout=1
YAML

if compose up -d; then
    printf 'deployment unexpectedly started after a failed migration\n' >&2
    exit 1
fi

failed_backend_container=$(compose ps --all --quiet backend)
case "$(docker inspect --format '{{.State.Status}}' "$failed_backend_container")" in
    exited|restarting) ;;
    *) exit 1 ;;
esac
test "$(docker inspect --format '{{.State.ExitCode}}' "$failed_backend_container")" -ne 0
test -z "$(compose ps --quiet frontend)"
