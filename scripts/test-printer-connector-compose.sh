#!/bin/sh
# Packages and validates the standalone printer-connector Compose bundle (see test-service-compose.sh).
set -eu
exec "$(dirname "$0")/test-service-compose.sh" "$(dirname "$0")/package-printer-connector-compose.sh" makerspace-connector connector no-certs
