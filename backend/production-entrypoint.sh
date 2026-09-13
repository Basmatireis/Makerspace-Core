#!/bin/sh

set -eu

goose -dir /app/migrations up
exec /app/api "$@"
