#!/bin/sh

# Lints the Up section of every goose migration that is new or changed since BASE (default
# origin/main) with squawk and the rules in .squawk.toml. Applied migrations are never edited,
# so older files are not linted; Down sections are expected to drop what Up created.

set -eu

base="${1:-origin/main}"
squawk_version="2.70.0"

files="$(git diff --name-only --diff-filter=AM "$base" HEAD -- 'backend/migrations/*.sql')"
if [ -z "$files" ]; then
	echo "No new or changed migrations since $base."
	exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT HUP INT TERM

for file in $files; do
	# Goose annotations become empty lines so squawk's line numbers match the source file.
	awk '/^-- \+goose Down/ { exit } /^-- \+goose/ { print ""; next } { print }' "$file" >"$work/$(basename "$file")"
done

echo "Linting the Up section of:"
printf '  %s\n' $files
npx --yes "squawk-cli@$squawk_version" --config .squawk.toml "$work"/*.sql
