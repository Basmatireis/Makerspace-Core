#!/bin/sh
# Prepares and starts the development local service (printer connector + go2rtc) next to `make dev`:
#   connector  printer-connector/compose.development.yaml  (make dev-connector)
# Creates .env from .env.example when missing, requires the one-time enrollment secret unless
# already enrolled, builds and starts the stack detached. Exits non-zero with instructions when the
# enrollment secret is missing.

set -eu

repository_directory=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

case "${1:-}" in
    connector)
        stack_directory="$repository_directory/printer-connector"
        project=makerspace-connector
        service=connector
        secret_variable=CONNECTOR_ENROLLMENT_SECRET
        data_directory=/var/lib/makerspace-printer-connector
        target=dev-connector
        ;;
    *)
        printf 'usage: %s connector\n' "$0" >&2
        exit 2
        ;;
esac
kind=$1

compose_file="$stack_directory/compose.development.yaml"
env_file="$stack_directory/.env"
stack_name=$(basename "$stack_directory")
compose() { docker compose -f "$compose_file" "$@"; }

if [ ! -f "$env_file" ]; then
    cp "$stack_directory/.env.example" "$env_file"
    printf 'Created %s/.env from .env.example.\n' "$stack_name"
fi

compose build

# Already enrolled? The daemon writes health.json into its data volume once enrollment succeeded.
secret_set=false
if grep -Eq "^$secret_variable=.+" "$env_file"; then
    secret_set=true
fi
if [ "$secret_set" = false ] && ! compose run --rm --no-deps --no-TTY --entrypoint test "$service" -f "$data_directory/health.json" >/dev/null 2>&1; then
    cat >&2 <<MESSAGE

The $kind stack is not enrolled yet and $secret_variable is not set.
  1. Start Core:  make dev   (on a fresh database also: make migrate-up, make bootstrap-master)
  2. In Core open Settings > Local services > Printer connectors and create a connector.
     Copy the one-time secret shown.
  3. Paste it into $stack_name/.env as $secret_variable=<secret>
  4. Run again:  make $target
MESSAGE
    exit 1
fi

compose up -d

printf '\nStarted the development %s stack (Compose project %s).\n' "$kind" "$project"
printf '  Logs:  make %s-logs\n  Stop:  make %s-down\n' "$target" "$target"
