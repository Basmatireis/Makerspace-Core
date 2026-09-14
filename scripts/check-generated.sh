#!/bin/sh

set -eu

snapshot="$(mktemp -d "${TMPDIR:-/tmp}/makerspace-generated.XXXXXX")"
cleanup() {
	rm -r -- "$snapshot"
}
trap cleanup EXIT HUP INT TERM

generated_paths='backend/internal/openapi
backend/internal/accounts/db
backend/internal/audit/db
backend/internal/auth/db
backend/internal/authorization/db
backend/internal/people/db
backend/internal/roles/db
backend/internal/opendays/db
frontend/src/api/generated'

for path in $generated_paths; do
	mkdir -p "$snapshot/$(dirname "$path")"
	cp -R "$path" "$snapshot/$path"
done

make generate

stale=0
for path in $generated_paths; do
	if ! diff -ru "$snapshot/$path" "$path"; then
		stale=1
	fi
done

if [ "$stale" -ne 0 ]; then
	echo "Generated files were stale; regenerated output has been left in the workspace." >&2
	exit 1
fi
