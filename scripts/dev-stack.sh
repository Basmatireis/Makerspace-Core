#!/bin/sh
# Prepares and starts a development local-service stack next to `make dev`:
#   connector  printer-connector/compose.development.yaml  (make dev-connector)
#   streaming  streaming-gateway/compose.development.yaml  (make dev-streaming)
# Creates .env from .env.example when missing, (streaming) generates a localhost certificate into
# ./certs, requires the one-time enrollment secret unless already enrolled, builds and starts the
# stack detached. Exits non-zero with instructions when the enrollment secret is missing.

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
    streaming)
        stack_directory="$repository_directory/streaming-gateway"
        project=makerspace-streaming
        service=streaming-gateway
        secret_variable=STREAM_ENROLLMENT_SECRET
        data_directory=/var/lib/makerspace-streaming-gateway
        target=dev-streaming
        ;;
    *)
        printf 'usage: %s connector|streaming\n' "$0" >&2
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

# A localhost certificate for the gateway: browser-trusted with mkcert when installed, otherwise
# self-signed. Files are named like certbot's output (fullchain.pem, privkey.pem).
self_signed=false
if [ "$kind" = streaming ]; then
    certs="$stack_directory/certs"
    mkdir -p "$certs"
    if [ ! -f "$certs/fullchain.pem" ] || [ ! -f "$certs/privkey.pem" ]; then
        if command -v mkcert >/dev/null 2>&1; then
            mkcert -cert-file "$certs/fullchain.pem" -key-file "$certs/privkey.pem" localhost 127.0.0.1
        else
            openssl_config=$(mktemp)
            trap 'rm -f "$openssl_config"' EXIT INT TERM
            cat >"$openssl_config" <<'CONFIG'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = localhost
[v3]
subjectAltName = DNS:localhost,IP:127.0.0.1
CONFIG
            openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \
                -config "$openssl_config" -keyout "$certs/privkey.pem" -out "$certs/fullchain.pem" 2>/dev/null
        fi
        printf 'Generated a localhost certificate in %s/certs.\n' "$stack_name"
    fi
    # The gateway runs as uid 10001, so the development files must be world-readable.
    chmod 755 "$certs"
    chmod 644 "$certs/fullchain.pem" "$certs/privkey.pem"
    if ! openssl x509 -in "$certs/fullchain.pem" -noout -issuer 2>/dev/null | grep -qi mkcert; then
        self_signed=true
    fi
fi

compose build

# Already enrolled? The daemon writes health.json into its data volume once enrollment succeeded.
secret_set=false
if grep -Eq "^$secret_variable=.+" "$env_file"; then
    secret_set=true
fi
if [ "$secret_set" = false ] && ! compose run --rm --no-deps --no-TTY --entrypoint test "$service" -f "$data_directory/health.json" >/dev/null 2>&1; then
    if [ "$kind" = connector ]; then
        where='In Core open Machines > Connectors and create a connector.'
    else
        where='In Core open Settings > Local services and add a gateway with the public host localhost:8443.'
    fi
    cat >&2 <<MESSAGE

The $kind stack is not enrolled yet and $secret_variable is not set.
  1. Start Core:  make dev   (on a fresh database also: make migrate-up, make bootstrap-master)
  2. $where
     Copy the one-time secret shown.
  3. Paste it into $stack_name/.env as $secret_variable=<secret>
  4. Run again:  make $target
MESSAGE
    exit 1
fi

compose up -d

printf '\nStarted the development %s stack (Compose project %s).\n' "$kind" "$project"
printf '  Logs:  make %s-logs\n  Stop:  make %s-down\n' "$target" "$target"
if [ "$self_signed" = true ]; then
    cat <<'MESSAGE'

The gateway uses a self-signed localhost certificate that browsers reject until you trust it once:
open https://localhost:8443/ in the browser you use for Core and accept the warning.
(With mkcert installed, delete streaming-gateway/certs and run `make dev-streaming` again for a
browser-trusted certificate.)
MESSAGE
fi
