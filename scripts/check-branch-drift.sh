#!/usr/bin/env bash
# Fail if any file listed in config/shared-files.txt differs between `main` and
# `stable`. See that file for the rationale and the escape hatch.
#
# Usage:  ./scripts/check-branch-drift.sh          (compares origin/main vs origin/stable)
#         BASE=main HEAD=stable ./scripts/check-branch-drift.sh
#
# Exits 0 when every listed file is byte-identical, 1 otherwise. Pure git — no
# npm install needed, so it runs before dependencies in CI.
set -uo pipefail

BASE="${BASE:-origin/main}"
HEAD="${HEAD:-origin/stable}"
LIST="$(dirname "$0")/../config/shared-files.txt"

if [ ! -f "$LIST" ]; then
    echo "❌ missing $LIST"
    exit 1
fi

fail=0
checked=0

while IFS= read -r line || [ -n "$line" ]; do
    # skip blanks and comments
    case "$line" in '' | \#*) continue ;; esac
    f="$line"

    a=$(git rev-parse "$BASE:$f" 2>/dev/null) || {
        echo "::error file=$f::listed as shared but missing on $BASE"
        fail=1
        continue
    }
    b=$(git rev-parse "$HEAD:$f" 2>/dev/null) || {
        echo "::error file=$f::listed as shared but missing on $HEAD"
        fail=1
        continue
    }

    checked=$((checked + 1))
    if [ "$a" != "$b" ]; then
        echo "::error file=$f::DRIFT — differs between $BASE and $HEAD"
        echo "     diff: git diff $BASE $HEAD -- $f"
        fail=1
    fi
done < "$LIST"

if [ "$fail" -eq 0 ]; then
    echo "✅ $checked shared file(s) identical across $BASE and $HEAD"
else
    echo ""
    echo "Shared files drifted between the two radars."
    echo "Either port the change to the other branch, or — if the divergence is"
    echo "intentional — remove the file from config/shared-files.txt and say why."
fi

exit "$fail"
