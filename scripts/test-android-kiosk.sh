#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
docker build --platform linux/amd64 --tag makerspace-core-android-kiosk-check "$repo_root/android-kiosk"
