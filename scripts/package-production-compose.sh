#!/bin/sh

set -eu

if [ "$#" -ne 2 ]; then
    printf 'usage: %s VERSION OUTPUT_DIRECTORY\n' "$0" >&2
    exit 2
fi

version=$1
output_directory=$2

if ! printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
    printf 'VERSION must have the form MAJOR.MINOR.PATCH without a leading v\n' >&2
    exit 2
fi

repository_directory=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
compose_template="$repository_directory/compose.production.yaml"
environment_template="$repository_directory/production.env.example"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/makerspace-core-compose.XXXXXX")
bundle_directory="$temporary_directory/bundle"
archive_name="makerspace-core-$version-compose.tar.gz"

cleanup() {
    rm -rf "$temporary_directory"
}
trap cleanup EXIT INT TERM

mkdir -p "$output_directory" "$bundle_directory"

token_count=$(grep -o '__MAKERSPACE_VERSION__' "$compose_template" | wc -l | tr -d ' ')
if [ "$token_count" -ne 2 ]; then
    printf 'expected exactly two application image version tokens, found %s\n' "$token_count" >&2
    exit 1
fi

sed "s/__MAKERSPACE_VERSION__/$version/g" "$compose_template" >"$bundle_directory/compose.yaml"
cp "$environment_template" "$bundle_directory/.env.example"

if grep -q '__MAKERSPACE_VERSION__' "$bundle_directory/compose.yaml"; then
    printf 'unresolved application image version token in packaged compose.yaml\n' >&2
    exit 1
fi

tar -czf "$output_directory/$archive_name" -C "$bundle_directory" compose.yaml .env.example
printf '%s\n' "$output_directory/$archive_name"
