#!/bin/sh

# Checks FRONTEND_ALLOWED_CLIENTS of the production frontend image: clients run in their own containers on
# one Docker network, so nginx sees their real addresses (no published port and no host NAT involved).

set -eu

repository_directory=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
test_id=$$
prefix="makerspace-core-allowed-clients-$test_id"
frontend_image="$prefix-frontend:test"
curl_image=curlimages/curl:8.16.0@sha256:463eaf6072688fe96ac64fa623fe73e1dbe25d8ad6c34404a669ad3ce1f104b6
network="$prefix-network"
server="$prefix-server"
client_a="$prefix-client-a"
client_b="$prefix-client-b"

cleanup() {
    status=$?
    trap - EXIT INT TERM
    if [ "$status" -ne 0 ]; then
        docker logs "$server" 2>&1 || true
    fi
    docker rm --force "$server" "$client_a" "$client_b" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
    docker image rm "$frontend_image" >/dev/null 2>&1 || true
    exit "$status"
}

trap cleanup EXIT INT TERM

cd "$repository_directory"

docker build --target final --tag "$frontend_image" --file frontend/Dockerfile .
docker network create "$network" >/dev/null
docker run --detach --name "$client_a" --network "$network" --entrypoint sleep "$curl_image" 600 >/dev/null
docker run --detach --name "$client_b" --network "$network" --entrypoint sleep "$curl_image" 600 >/dev/null

container_ip() {
    docker inspect --format "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$1"
}

client_a_ip=$(container_ip "$client_a")
client_b_ip=$(container_ip "$client_b")
subnet=$(docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' "$network")
test -n "$client_a_ip"
test -n "$client_b_ip"
test -n "$subnet"

# start_server [docker run options...]: replaces the server and waits until it answers on loopback.
start_server() {
    docker rm --force "$server" >/dev/null 2>&1 || true
    docker run --detach --name "$server" --network "$network" "$@" "$frontend_image" >/dev/null
    attempts=0
    until docker exec "$server" wget -q -O /dev/null http://127.0.0.1:8080/ 2>/dev/null; do
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 30 ]; then
            printf 'frontend did not start with %s\n' "$*" >&2
            return 1
        fi
        sleep 1
    done
}

# status CLIENT PATH: prints the HTTP status the client gets from the server.
status() {
    docker exec "$1" curl --silent --show-error --output /dev/null --write-out '%{http_code}' "http://$server:8080$2"
}

expect_status() {
    actual=$(status "$1" "$2")
    if [ "$actual" != "$3" ]; then
        printf '%s %s: expected %s, got %s\n' "$1" "$2" "$3" "$actual" >&2
        return 1
    fi
}

expect_denied() {
    for path in / /player /player/ /assets/missing.js /api/v1/health/ready; do
        expect_status "$1" "$path" 403
    done
    headers=$(docker exec "$1" curl --silent --show-error --dump-header - --output /dev/null "http://$server:8080/")
    for header in 'Cache-Control: no-store' 'Strict-Transport-Security: max-age=31536000' \
        'X-Content-Type-Options: nosniff' 'X-Frame-Options: DENY' 'Referrer-Policy: same-origin' \
        "Content-Security-Policy: default-src 'self'"; do
        printf '%s\n' "$headers" | grep -i "^$header" >/dev/null || {
            printf 'denied response lacks %s:\n%s\n' "$header" "$headers" >&2
            return 1
        }
    done
    # Upgrade requests are refused the same way before reaching the API.
    upgrade=$(docker exec "$1" curl --silent --output /dev/null --write-out '%{http_code}' \
        --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
        "http://$server:8080/api/v1/printer-connector/self/stream-control")
    test "$upgrade" = 403
}

# expect_start_failure ALLOWED MESSAGE: the container must exit non-zero and log MESSAGE.
expect_start_failure() {
    docker rm --force "$server" >/dev/null 2>&1 || true
    if docker run --name "$server" --network "$network" --env "FRONTEND_ALLOWED_CLIENTS=$1" \
        "$frontend_image" >"/dev/null" 2>&1; then
        printf 'frontend started with invalid FRONTEND_ALLOWED_CLIENTS=%s\n' "$1" >&2
        return 1
    fi
    exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$server")
    test "$exit_code" -ne 0
    docker logs "$server" 2>&1 | grep -F "$2" >/dev/null || {
        printf 'missing start failure message %s\n' "$2" >&2
        return 1
    }
}

# Unset (and empty): every client is allowed.
start_server
expect_status "$client_a" / 200
expect_status "$client_b" / 200
start_server --env "FRONTEND_ALLOWED_CLIENTS="
expect_status "$client_a" / 200
expect_status "$client_b" / 200
start_server --env "FRONTEND_ALLOWED_CLIENTS= , "
expect_status "$client_b" / 200

# A single address among other entries, with spaces around them.
start_server --env "FRONTEND_ALLOWED_CLIENTS= 203.0.113.7 , $client_a_ip ,2001:db8::/32 "
expect_status "$client_a" / 200
expect_status "$client_a" /player/ 200
expect_denied "$client_b"

# CIDR ranges.
start_server --env "FRONTEND_ALLOWED_CLIENTS=$client_a_ip/32"
expect_status "$client_a" / 200
expect_denied "$client_b"
start_server --env "FRONTEND_ALLOWED_CLIENTS=$subnet"
expect_status "$client_a" / 200
expect_status "$client_b" / 200

# Hostnames are resolved at start (here through /etc/hosts).
start_server --env "FRONTEND_ALLOWED_CLIENTS=client-a.allowed-clients.test" --add-host "client-a.allowed-clients.test:$client_a_ip"
docker logs "$server" 2>&1 | grep -F "allowing client-a.allowed-clients.test ($client_a_ip)" >/dev/null
expect_status "$client_a" / 200
expect_denied "$client_b"

# The healthcheck keeps passing with a list that excludes every other client.
docker rm --force "$server" >/dev/null 2>&1 || true
docker run --detach --name "$server" --network "$network" --env FRONTEND_ALLOWED_CLIENTS=203.0.113.7 \
    --health-cmd 'wget -q -O /dev/null http://127.0.0.1:8080/' --health-interval 1s --health-retries 20 \
    "$frontend_image" >/dev/null
attempts=0
until [ "$(docker inspect --format '{{.State.Health.Status}}' "$server")" = healthy ]; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
        printf 'frontend did not become healthy with a restrictive list\n' >&2
        exit 1
    fi
    sleep 1
done
expect_denied "$client_a"

# Invalid entries stop the container and name the entry.
expect_start_failure '203.0.113.7,not a host' '"not a host" is neither an address'
expect_start_failure '1.2.3' '"1.2.3" is not a valid IPv4 address'
expect_start_failure '203.0.113.0/33' '"203.0.113.0/33" is not a valid IPv4 address'
expect_start_failure '2001:db8::/129' '"2001:db8::/129" is not a valid IPv6 address'
expect_start_failure 'missing.allowed-clients.invalid' 'hostname "missing.allowed-clients.invalid" does not resolve'

printf 'FRONTEND_ALLOWED_CLIENTS checks passed\n'
