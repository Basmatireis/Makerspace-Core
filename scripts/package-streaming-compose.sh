#!/bin/sh
# Usage: package-streaming-compose.sh VERSION OUTPUT_DIRECTORY
set -eu
if [ "$#" -ne 2 ]; then
    printf 'usage: %s VERSION OUTPUT_DIRECTORY\n' "$0" >&2
    exit 2
fi
exec "$(dirname "$0")/package-service-compose.sh" streaming-gateway makerspace-streaming "$1" "$2" with-certs
