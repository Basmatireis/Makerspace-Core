#!/bin/sh

# Lints the Up section of every goose migration that is new or changed since BASE (default
# origin/main), or of the staged migrations with `--staged`, with squawk and the rules in .squawk.toml. Applied migrations are never edited,
# so older files are not linted; Down sections are expected to drop what Up created.

set -eu

base="${1:-origin/main}"
squawk_version="2.70.0"

if [ "$base" = --staged ]; then
	files="$(git diff --cached --name-only --diff-filter=AM -- 'backend/migrations/*.sql')"
else
	files="$(git diff --name-only --diff-filter=AM "$base" HEAD -- 'backend/migrations/*.sql')"
fi
if [ -z "$files" ]; then
	echo "No new or changed migrations ($base)."
	exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT HUP INT TERM

for file in $files; do
	# Goose annotations become empty lines so squawk's line numbers match the source file.
	if [ "$base" = --staged ]; then
		git show ":$file"
	else
		cat "$file"
	fi | awk '/^-- \+goose Down/ { exit } /^-- \+goose/ { print ""; next } { print }' >"$work/$(basename "$file")"
done

echo "Linting the Up section of:"
printf '  %s\n' $files
npx --yes "squawk-cli@$squawk_version" --config .squawk.toml "$work"/*.sql
