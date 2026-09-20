#!/bin/sh

set -eu

snapshot="$(mktemp -d "${TMPDIR:-/tmp}/makerspace-generated.XXXXXX")"
cleanup() {
	rm -r -- "$snapshot"
}
trap cleanup EXIT HUP INT TERM

# sqlc.yaml uses one scalar output path per line. Fail closed if that shape
# changes rather than silently leaving a new feature out of freshness checks.
sqlc_paths=$(awk '
    /^[[:space:]]+out:/ {
        path = $2
        gsub(/"/, "", path)
        if (NF != 2 || path !~ /^internal\/[a-z0-9_]+\/db$/) exit 1
        print "backend/" path
        count++
    }
    END { if (count == 0) exit 1 }
' backend/sqlc.yaml)

generated_paths="backend/internal/openapi
$sqlc_paths
frontend/src/api/generated"

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
