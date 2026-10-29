#!/bin/sh
# Packages and validates the printer-connector Compose bundle (connector + go2rtc; see test-service-compose.sh).
set -eu
exec "$(dirname "$0")/test-service-compose.sh" "$(dirname "$0")/package-printer-connector-compose.sh" makerspace-connector connector,go2rtc,go2rtc-config-init
