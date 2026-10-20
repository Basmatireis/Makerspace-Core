#!/bin/sh
# Shared validation for the local-service release bundles (no images are pulled or started):
#   test-service-compose.sh PACKAGE_SCRIPT PROJECT_NAME EXPECTED_SERVICES(comma-separated) with-certs|no-certs
# Packages the bundle as version 0.0.0, checks its contents, and validates that Compose renders it
# with the shipped .env.example plus a sample enrollment secret: pinned image tags, hardened
# containers, no host networking, and only the intended published ports.

set -eu

if [ "$#" -ne 4 ]; then
    printf 'usage: %s PACKAGE_SCRIPT PROJECT_NAME SERVICES with-certs|no-certs\n' "$0" >&2
    exit 2
fi
package_script=$1
project_name=$2
expected_services=$(printf '%s\n' "$3" | tr ',' '\n' | sort)
with_certs=$4

repository_directory=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/makerspace-service-smoke.XXXXXX")
deployment_directory="$temporary_directory/deployment"
version=0.0.0
cleanup() { rm -rf "$temporary_directory"; }
trap cleanup EXIT INT TERM

cd "$repository_directory"
archive_path=$("$package_script" "$version" "$temporary_directory")
archive_entries=$(tar -tzf "$archive_path" | grep -v '/$' | sort)
if [ "$with_certs" = with-certs ]; then
    expected_entries=$(printf '%s\n' .env.example certs/README compose.yaml)
else
    expected_entries=$(printf '%s\n' .env.example compose.yaml)
fi
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
    printf 'STREAM_ENROLLMENT_SECRET=smoke-stream-secret\n'
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
    if [ "$with_certs" = no-certs ]; then
        test -z "$(printf '%s\n' "$rendered" | grep -E 'published:' || true)"
        printf '%s\n' "$rendered" | grep -F 'read_only: true' >/dev/null
    fi
    if [ "$with_certs" = with-certs ]; then
        printf '%s\n' "$rendered" | grep -F 'STREAM_TLS_CERT_FILE: /certs/fullchain.pem' >/dev/null
        printf '%s\n' "$rendered" | grep -F 'read_only: true' >/dev/null
        # go2rtc's API (1984) and RTSP (8554) must never be published.
        test -z "$(printf '%s\n' "$rendered" | grep -E 'published: "(1984|8554)"' || true)"
        # Both TLS modes must render: ACME variables reach the gateway, and the certs directory is optional.
        printf '%s\n' "$rendered" | grep -E '^ +ACME_EMAIL:' >/dev/null
        printf '%s\n' "$rendered" | grep -E '^ +CLOUDFLARE_DNS_API_TOKEN:' >/dev/null
        grep -E '^ACME_EMAIL=$' .env.example >/dev/null
        grep -E '^CLOUDFLARE_DNS_API_TOKEN=$' .env.example >/dev/null
        {
            printf 'ACME_EMAIL=ops@example.org\n'
            printf 'CLOUDFLARE_DNS_API_TOKEN=smoke-cloudflare-token\n'
        } >>.env
        rm -rf certs
        acme_rendered=$(docker compose config)
        printf '%s\n' "$acme_rendered" | grep -F 'ACME_EMAIL: ops@example.org' >/dev/null
        printf '%s\n' "$acme_rendered" | grep -F 'CLOUDFLARE_DNS_API_TOKEN: smoke-cloudflare-token' >/dev/null
    fi
)
