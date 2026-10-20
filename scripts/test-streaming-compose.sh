#!/bin/sh
# Packages and validates the standalone streaming-gateway Compose bundle (see test-service-compose.sh).
set -eu
exec "$(dirname "$0")/test-service-compose.sh" "$(dirname "$0")/package-streaming-compose.sh" makerspace-streaming streaming-gateway,go2rtc,go2rtc-config-init with-certs
