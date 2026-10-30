#!/bin/sh
# Writes /etc/nginx/allowed-clients.conf from FRONTEND_ALLOWED_CLIENTS before nginx starts (run by the
# nginx image's /docker-entrypoint.sh). The variable is a comma-separated list of IPv4/IPv6 addresses,
# CIDR ranges and hostnames. Hostnames are resolved once, here; nginx is not told about later DNS
# changes until the container restarts. Unset or empty allows every client. Loopback always stays
# allowed for the container's own healthcheck. An entry that is neither an address, a range nor a
# resolvable hostname stops the container instead of silently allowing everyone.

set -eu

target=/etc/nginx/allowed-clients.conf
temporary="$target.tmp"

fail() {
    printf '%s: FRONTEND_ALLOWED_CLIENTS: %s\n' "$0" "$1" >&2
    exit 1
}

valid_ipv4() {
    address=${1%%/*}
    case "$1" in
        */*)
            prefix=${1#*/}
            case "$prefix" in '' | *[!0-9]*) return 1 ;; esac
            [ "${#prefix}" -le 2 ] && [ "$prefix" -le 32 ] || return 1
            ;;
    esac
    old_ifs=$IFS
    IFS=.
    # shellcheck disable=SC2086 # split the address into its octets
    set -- $address
    IFS=$old_ifs
    [ "$#" -eq 4 ] || return 1
    case "$address" in *.) return 1 ;; esac
    for octet in "$@"; do
        case "$octet" in '' | *[!0-9]*) return 1 ;; esac
        [ "${#octet}" -le 3 ] && [ "$octet" -le 255 ] || return 1
    done
}

valid_ipv6() {
    address=${1%%/*}
    case "$1" in
        */*)
            prefix=${1#*/}
            case "$prefix" in '' | *[!0-9]*) return 1 ;; esac
            [ "${#prefix}" -le 3 ] && [ "$prefix" -le 128 ] || return 1
            ;;
    esac
    # nginx checks the exact syntax when it loads the configuration; this only tells addresses from hostnames.
    case "$address" in *:*:*) ;; *) return 1 ;; esac
    case "$address" in *[!0-9A-Fa-f:.]*) return 1 ;; esac
}

valid_hostname() {
    case "$1" in
        '' | .* | *..* | -* | *[!0-9A-Za-z.-]*) return 1 ;;
    esac
    [ "${#1}" -le 253 ]
}

sources=
add_source() {
    sources="$sources$1
"
}

old_ifs=$IFS
IFS=,
set -f
# shellcheck disable=SC2086 # split the list at commas
set -- ${FRONTEND_ALLOWED_CLIENTS:-}
set +f
IFS=$old_ifs

for raw in "$@"; do
    entry=$(printf '%s' "$raw" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    [ -n "$entry" ] || continue
    case "$entry" in
        *:*)
            valid_ipv6 "$entry" || fail "\"$entry\" is not a valid IPv6 address or range"
            add_source "$entry"
            ;;
        *[!0-9./]*)
            valid_hostname "$entry" || fail "\"$entry\" is neither an address, a CIDR range nor a hostname"
            resolved=$(getent ahosts "$entry" | awk '{ print $1 }' | sort -u) || true
            [ -n "$resolved" ] || fail "hostname \"$entry\" does not resolve"
            printf '%s: allowing %s (%s)\n' "$0" "$entry" "$(printf '%s' "$resolved" | tr '\n' ' ' | sed 's/ $//')"
            add_source "$resolved"
            ;;
        *)
            valid_ipv4 "$entry" || fail "\"$entry\" is not a valid IPv4 address or range"
            add_source "$entry"
            ;;
    esac
done

if [ -n "$sources" ]; then
    add_source 127.0.0.0/8
    add_source ::1
fi

{
    printf '# Generated at container start from FRONTEND_ALLOWED_CLIENTS. Do not edit.\n'
    # shellcheck disable=SC2016 # an nginx variable, not a shell one
    printf 'geo $makerspace_client_allowed {\n'
    if [ -z "$sources" ]; then
        printf '    default 1;\n'
    else
        printf '    default 0;\n'
        printf '%s' "$sources" | sort -u | while read -r source; do
            [ -n "$source" ] && printf '    %s 1;\n' "$source"
        done
    fi
    printf '}\n'
} >"$temporary"
mv "$temporary" "$target"

if [ -z "$sources" ]; then
    printf '%s: FRONTEND_ALLOWED_CLIENTS is empty, every client is allowed\n' "$0"
else
    printf '%s: only loopback and FRONTEND_ALLOWED_CLIENTS are allowed\n' "$0"
fi
