#!/bin/sh

set -eu

repository_directory=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/makerspace-printer-connector-smoke.XXXXXX")
deployment_directory="$temporary_directory/deployment"
version=0.0.0

cleanup() {
    rm -rf "$temporary_directory"
}
trap cleanup EXIT INT TERM

cd "$repository_directory"
archive_path=$(./scripts/package-printer-connector-compose.sh "$version" "$temporary_directory")
archive_entries=$(tar -tzf "$archive_path" | sort)
expected_entries=$(printf '%s\n' .env.example compose.yaml secrets/README)
test "$archive_entries" = "$expected_entries"

mkdir "$deployment_directory"
tar -xzf "$archive_path" -C "$deployment_directory"
test "$(grep -c ":$version" "$deployment_directory/compose.yaml")" = 1
test -z "$(grep -F '__MAKERSPACE_VERSION__' "$deployment_directory/compose.yaml" || true)"

mkdir -p "$deployment_directory/secrets"
printf '%s' 'compose-smoke-enrollment-secret' >"$deployment_directory/secrets/printer-connector-enrollment"
chmod 0600 "$deployment_directory/secrets/printer-connector-enrollment"

(
    cd "$deployment_directory"
    CORE_URL=https://makerspace.example.test \
    MAKERSPACE_IMAGE_PREFIX=makerspace-core-printer-connector-smoke \
    docker compose config --quiet
    services=$(CORE_URL=https://makerspace.example.test MAKERSPACE_IMAGE_PREFIX=makerspace-core-printer-connector-smoke docker compose config --services)
    test "$services" = connector
    rendered=$(CORE_URL=https://makerspace.example.test MAKERSPACE_IMAGE_PREFIX=makerspace-core-printer-connector-smoke docker compose config)
    test -z "$(printf '%s\n' "$rendered" | grep -E 'published:|host_mode:|network_mode: host' || true)"
    printf '%s\n' "$rendered" | grep -F 'read_only: true' >/dev/null
    printf '%s\n' "$rendered" | grep -F 'connector_data:' >/dev/null
)
