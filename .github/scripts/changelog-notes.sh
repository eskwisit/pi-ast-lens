#!/usr/bin/env bash
# Print the CHANGELOG.md section of one version, without its "## <version>" heading.
# usage: changelog-notes.sh <version> [changelog]
# Exits 1 (printing nothing) when the changelog has no section for that version.
set -euo pipefail

version="${1:?usage: changelog-notes.sh <version> [changelog]}"
file="${2:-CHANGELOG.md}"

# a section runs from "## <version>" (any suffix, e.g. "— unreleased") to the next "## " heading
section=$(awk -v v="$version" '
  /^## / { if (found) exit; if ($2 == v) { found = 1; next } }
  found { print }
' "$file")

# drop the blank lines before the section; $( ) already drops the ones after it
section=$(printf '%s\n' "$section" | sed -e '/./,$!d')

[ -n "$section" ] || exit 1
printf '%s\n' "$section"
