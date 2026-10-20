#!/bin/sh
# Packages a local-service stack (printer-connector, streaming-gateway, local-services) as a release
# bundle. Used by package-printer-connector-compose.sh, package-streaming-compose.sh and
# package-local-services-compose.sh.
#
#   package-service-compose.sh STACK_DIRECTORY ARCHIVE_PREFIX VERSION OUTPUT_DIRECTORY [with-certs]
#
# The bundle holds the stack's unchanged compose.yaml and its .env.example with MAKERSPACE_VERSION
# set to VERSION. With "with-certs" it also holds certs/README, the place for the TLS certificate.

set -eu

if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
    printf 'usage: %s STACK_DIRECTORY ARCHIVE_PREFIX VERSION OUTPUT_DIRECTORY [with-certs]\n' "$0" >&2
    exit 2
fi

stack=$1
archive_prefix=$2
version=$3
output_directory=$4
with_certs=${5:-}
if ! printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
    printf 'VERSION must have the form MAJOR.MINOR.PATCH without a leading v\n' >&2
    exit 2
fi

repository_directory=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
source_directory="$repository_directory/$stack"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/makerspace-service-compose.XXXXXX")
bundle_directory="$temporary_directory/bundle"
archive_name="$archive_prefix-$version-compose.tar.gz"
cleanup() { rm -rf "$temporary_directory"; }
trap cleanup EXIT INT TERM

mkdir -p "$output_directory" "$bundle_directory"
cp "$source_directory/compose.yaml" "$bundle_directory/compose.yaml"

if [ "$(grep -c '^MAKERSPACE_VERSION=0\.0\.0$' "$source_directory/.env.example")" -ne 1 ]; then
    printf 'expected exactly one MAKERSPACE_VERSION=0.0.0 placeholder in %s/.env.example\n' "$stack" >&2
    exit 1
fi
sed "s/^MAKERSPACE_VERSION=0\.0\.0\$/MAKERSPACE_VERSION=$version/" "$source_directory/.env.example" >"$bundle_directory/.env.example"

entries="compose.yaml .env.example"
if [ "$with_certs" = with-certs ]; then
    mkdir "$bundle_directory/certs"
    cat >"$bundle_directory/certs/README" <<'README'
Put the TLS certificate chain and private key for STREAM_PUBLIC_HOST here as fullchain.pem and
privkey.pem (the file names certbot and acme.sh produce). The gateway runs as uid 10001 and must be
able to read both files. This directory is mounted read-only; a renewed certificate is picked up
within about a minute without a restart. See docs/hosting.md.
README
    entries="$entries certs/README"
fi

# shellcheck disable=SC2086
tar -czf "$output_directory/$archive_name" -C "$bundle_directory" $entries
printf '%s\n' "$output_directory/$archive_name"
