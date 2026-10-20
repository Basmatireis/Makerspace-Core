#!/bin/sh
# Packages and validates the local-services Compose bundle (see test-service-compose.sh).
set -eu
exec "$(dirname "$0")/test-service-compose.sh" "$(dirname "$0")/package-local-services-compose.sh" makerspace-local-services printer-connector,streaming-gateway,go2rtc with-certs
