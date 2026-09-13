#!/bin/sh

set -eu

repository_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
production_compose_file="$repository_dir/compose.production.yaml"
smoke_id=$$
image_prefix="makerspace-core-production-smoke-$smoke_id"
image_version=local
backend_image="$image_prefix-backend:$image_version"
frontend_image="$image_prefix-frontend:$image_version"

export COMPOSE_PROJECT_NAME="makerspace-core-production-smoke-$smoke_id"
export MAKERSPACE_IMAGE_PREFIX="$image_prefix"
export MAKERSPACE_VERSION="$image_version"
export PUBLIC_BASE_URL=https://makerspace.example.test
export FRONTEND_BIND_ADDRESS=127.0.0.1
export FRONTEND_PORT=0
export POSTGRES_DB=makerspace
export POSTGRES_USER=makerspace
export POSTGRES_PASSWORD=production-smoke-password
export OTEL_SDK_DISABLED=true

compose() {
    docker compose -f "$production_compose_file" "$@"
}

cleanup() {
    status=$?
    trap - EXIT INT TERM
    if [ "$status" -ne 0 ]; then
        compose logs --no-color || true
    fi
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    docker image rm "$backend_image" "$frontend_image" >/dev/null 2>&1 || true
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

cd "$repository_dir"

docker build --target final --tag "$backend_image" --file backend/Dockerfile .
docker build --target final --tag "$frontend_image" --file frontend/Dockerfile .

compose config --quiet
services=$(compose config --services)
test "$(printf '%s\n' "$services" | wc -l | tr -d ' ')" = 3
printf '%s\n' "$services" | grep -Fx db >/dev/null
printf '%s\n' "$services" | grep -Fx backend >/dev/null
printf '%s\n' "$services" | grep -Fx frontend >/dev/null

compose up --detach --wait db
compose run --rm --no-deps --entrypoint goose backend -dir /app/migrations up
compose up --detach --wait backend frontend

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

# NGINX resolves the Compose service name dynamically, so replacing the API
# container must not require replacing or restarting the frontend container.
compose up --detach --wait --no-deps --force-recreate backend
wait_for_url "$frontend_url/api/v1/health/ready"
