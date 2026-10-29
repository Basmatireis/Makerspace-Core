#!/bin/sh
# Validation of the local-service release bundle (no images are pulled or started):
#   test-service-compose.sh PACKAGE_SCRIPT PROJECT_NAME EXPECTED_SERVICES(comma-separated)
# Packages the bundle as version 0.0.0, checks its contents, and validates that Compose renders it
# with the shipped .env.example plus a sample enrollment secret: pinned image tags, hardened
# containers, no host networking, no published port at all, go2rtc pinned by digest and attached only
# to the internal network and its own egress network, and the Docker socket only in the optional
# updater (profile "updater").

set -eu

if [ "$#" -ne 3 ]; then
    printf 'usage: %s PACKAGE_SCRIPT PROJECT_NAME SERVICES\n' "$0" >&2
    exit 2
fi
package_script=$1
project_name=$2
expected_services=$(printf '%s\n' "$3" | tr ',' '\n' | sort)

repository_directory=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/makerspace-service-smoke.XXXXXX")
deployment_directory="$temporary_directory/deployment"
version=0.0.0
cleanup() { rm -rf "$temporary_directory"; }
trap cleanup EXIT INT TERM

cd "$repository_directory"
archive_path=$("$package_script" "$version" "$temporary_directory")
archive_entries=$(tar -tzf "$archive_path" | grep -v '/$' | sort)
expected_entries=$(printf '%s\n' .env.example compose.yaml)
test "$archive_entries" = "$expected_entries"

mkdir "$deployment_directory"
tar -xzf "$archive_path" -C "$deployment_directory"
test "$(grep -c '^MAKERSPACE_VERSION=' "$deployment_directory/.env.example")" = 1
grep -Fx "MAKERSPACE_VERSION=$version" "$deployment_directory/.env.example" >/dev/null
test -z "$(grep -F '__MAKERSPACE_VERSION__' "$deployment_directory/compose.yaml" || true)"
# The legacy secret files are gone: enrollment comes from the environment.
test -z "$(grep -E 'secrets:|_SECRET_FILE' "$deployment_directory/compose.yaml" || true)"

cp "$deployment_directory/.env.example" "$deployment_directory/.env"
{
    printf 'MAKERSPACE_IMAGE_PREFIX=makerspace-core-service-smoke\n'
    printf 'CONNECTOR_ENROLLMENT_SECRET=smoke-connector-secret\n'
} >>"$deployment_directory/.env"

(
    cd "$deployment_directory"
    docker compose config --quiet
    test "$(docker compose config --services | sort)" = "$expected_services"
    rendered=$(docker compose config)
    printf '%s\n' "$rendered" | grep -Fx "name: $project_name" >/dev/null
    test -z "$(printf '%s\n' "$rendered" | grep -E 'network_mode: host|privileged: true' || true)"
    printf '%s\n' "$rendered" | grep -F "makerspace-core-service-smoke-" | grep -F ":$version" >/dev/null
    printf '%s\n' "$rendered" | grep -F 'no-new-privileges:true' >/dev/null
    # Without the updater profile no container gets the Docker socket.
    test -z "$(printf '%s\n' "$rendered" | grep -F 'docker.sock' || true)"
    test "$(COMPOSE_PROFILES=updater docker compose config --services | sort)" = "$(printf '%s\nupdater\n' "$expected_services" | sort)"
    for service in $expected_services; do
        test -z "$(COMPOSE_PROFILES=updater docker compose config "$service" | grep -F 'docker.sock' || true)"
    done
    updater=$(COMPOSE_PROFILES=updater docker compose config updater)
    printf '%s\n' "$updater" | grep -F 'target: /var/run/docker.sock' >/dev/null
    printf '%s\n' "$updater" | grep -F 'network_mode: none' >/dev/null
    printf '%s\n' "$updater" | grep -F "makerspace-core-service-smoke-local-updater:$version" >/dev/null
    # The updater never recreates itself, and recreates only services of this bundle.
    updater_services=$(printf '%s\n' "$updater" | sed -n 's/^ *UPDATER_SERVICES: *//p' | tr ',' '\n' | sort)
    test -n "$updater_services"
    test -z "$(printf '%s\n' "$updater_services" | grep -Fx updater || true)"
    for service in $updater_services; do
        printf '%s\n' "$expected_services" | grep -Fx "$service" >/dev/null
    done
    # Nothing is published: players reach cameras through Core, never through this host.
    test -z "$(printf '%s\n' "$rendered" | grep -E 'published:|^ +ports:' || true)"
    printf '%s\n' "$rendered" | grep -F 'read_only: true' >/dev/null
    # go2rtc is pinned by tag and digest, runs as the connector's uid and has no direct Core access.
    printf '%s\n' "$rendered" | grep -E 'image: alexxit/go2rtc:[0-9.]+@sha256:[0-9a-f]{64}$' >/dev/null
    printf '%s\n' "$rendered" | grep -F 'GO2RTC_API_URL: http://go2rtc:1984' >/dev/null
    printf '%s\n' "$rendered" | grep -F 'GO2RTC_CONFIG_FILE: /go2rtc-config/go2rtc.yaml' >/dev/null
    printf '%s\n' "$rendered" | grep -F 'internal: true' >/dev/null
    # Networks of one rendered service: the keys below its "networks:" line.
    service_networks() {
        docker compose config "$1" | awk -v service="$1" '
            $0 == "  " service ":" { in_service = 1; next }
            in_service && /^  [^ ]/ { in_service = 0 }
            in_service && /^    networks:/ { in_networks = 1; next }
            in_service && in_networks && /^      [^ ]/ { sub(/:.*/, ""); gsub(/ /, ""); print; next }
            in_networks && !/^      / { in_networks = 0 }
        ' | sort
    }
    test "$(service_networks go2rtc)" = "$(printf 'go2rtc_egress\ninternal\n')"
    test "$(service_networks connector)" = "$(printf 'connector_egress\ninternal\n')"
)
