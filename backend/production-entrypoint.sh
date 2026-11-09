#!/bin/sh

set -eu

# On a new volume the PostgreSQL image reports ready during its initialization and then restarts once,
# so the first connection can be refused. Wait up to a minute for a connection before migrating; a
# failing migration itself is not retried.
attempt=1
until goose -dir /app/migrations status >/dev/null 2>&1; do
    if [ "$attempt" -ge 30 ]; then
        # Last try with its error visible; set -e ends the container if it still fails.
        goose -dir /app/migrations status >/dev/null
        break
    fi
    attempt=$((attempt + 1))
    sleep 2
done

goose -dir /app/migrations up
exec /app/api "$@"
