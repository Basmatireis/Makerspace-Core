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
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/makerspace-printer-connector-compose.XXXXXX")
bundle_directory="$temporary_directory/bundle"
archive_name="makerspace-printer-connector-$version-compose.tar.gz"
cleanup() { rm -rf "$temporary_directory"; }
trap cleanup EXIT INT TERM

mkdir -p "$output_directory" "$bundle_directory/secrets"
sed "s/__MAKERSPACE_VERSION__/$version/g" "$repository_directory/printer-connector/compose.production.yaml" >"$bundle_directory/compose.yaml"
cp "$repository_directory/printer-connector/.env.example" "$bundle_directory/.env.example"
printf 'Paste the one-time enrollment secret here, then restrict this file to the deployment account.\n' >"$bundle_directory/secrets/README"
tar -czf "$output_directory/$archive_name" -C "$bundle_directory" compose.yaml .env.example secrets/README
printf '%s\n' "$output_directory/$archive_name"

