#!/usr/bin/env bash
# Fail if any file listed in config/shared-files.txt differs between the two
# radar branches. See that file for the rationale and the escape hatch.
#
# Usage:
#   ./scripts/check-branch-drift.sh                      # origin/main vs origin/stable
#   BASE=HEAD HEAD_REF=origin/stable ./scripts/...       # a PR head vs the other branch
#   ./scripts/check-branch-drift.sh --suggest            # also list unguarded shared files
#
# IMPORTANT — why BASE/HEAD_REF are overridable: comparing the two *branch tips*
# only ever catches drift that has already merged. To gate a PR you must compare
# the PR's own commit against the opposite branch, which is what branch-drift.yml
# does. Tip-vs-tip on a pull_request event reports a green check that says
# nothing about the PR.
#
# Exits 0 when every listed file matches, 1 otherwise. Pure git — no npm install,
# so it runs before dependencies and cannot be masked by a dependency failure.
#
# Deliberately NOT `set -e`: we want to report every drifted file in one run, not
# abort on the first. Do not "fix" this to -euo without rethinking the loop.
set -uo pipefail

BASE="${BASE:-origin/main}"
HEAD_REF="${HEAD_REF:-origin/stable}"
SUGGEST=0
[ "${1:-}" = "--suggest" ] && SUGGEST=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIST="$SCRIPT_DIR/../config/shared-files.txt"

if [ ! -f "$LIST" ]; then
    echo "❌ missing $LIST"
    exit 1
fi

echo "Comparing shared files:  $BASE  vs  $HEAD_REF"

fail=0
checked=0

while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | \#*) continue ;; esac
    f="$line"

    a=$(git rev-parse "$BASE:$f" 2>/dev/null) || {
        echo "::error file=$f::listed as shared but missing on $BASE"
        fail=1
        continue
    }
    b=$(git rev-parse "$HEAD_REF:$f" 2>/dev/null) || {
        echo "::error file=$f::listed as shared but missing on $HEAD_REF"
        fail=1
        continue
    }

    checked=$((checked + 1))
    if [ "$a" != "$b" ]; then
        echo "::error file=$f::DRIFT — differs between $BASE and $HEAD_REF"
        echo "     diff: git diff $BASE $HEAD_REF -- $f"
        fail=1
    fi
done < "$LIST"

# Advisory only — never fails the build. Catches the opposite blind spot: a file
# identical on both branches that nobody remembered to add to the list, and so is
# not guarded at all.
if [ "$SUGGEST" -eq 1 ]; then
    echo ""
    echo "— unguarded shared files (identical on both branches, not in the list) —"
    found=0
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        x=$(git rev-parse "$BASE:$f" 2>/dev/null) || continue
        y=$(git rev-parse "$HEAD_REF:$f" 2>/dev/null) || continue
        [ "$x" != "$y" ] && continue
        if ! grep -qxF "$f" "$LIST"; then
            echo "::warning file=$f::identical on both branches but not in config/shared-files.txt"
            found=1
        fi
    done < <(comm -12 \
        <(git ls-tree -r --name-only "$BASE" src/ | sort) \
        <(git ls-tree -r --name-only "$HEAD_REF" src/ | sort))
    [ "$found" -eq 0 ] && echo "  none — the list is complete"
fi

echo ""
if [ "$fail" -eq 0 ]; then
    echo "✅ $checked shared file(s) identical across $BASE and $HEAD_REF"
else
    echo "Shared files drifted between the two radars."
    echo "Either port the change to the other branch, or — if the divergence is"
    echo "intentional — remove the file from config/shared-files.txt and say why."
fi

exit "$fail"
