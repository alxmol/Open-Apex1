#!/usr/bin/env bash
# Reset py-failing-tests to its seeded-failure state.
# The seeded state IS the checked-in state, so reset amounts to reverting
# local modifications to tracked files + wiping untracked files.
#
# Note: fixtures live inside the parent repo's git, so we can't use
# `git reset --hard` without blowing away the rest of the monorepo. Instead
# we check out the two files we care about.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

# Restore the seeded file contents from git index, if available.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git checkout -- src/calculator/__init__.py tests/test_calculator.py 2>/dev/null || true
fi

# Wipe pytest + venv artifacts that could pollute reruns.
rm -rf .pytest_cache __pycache__ src/__pycache__ tests/__pycache__ src/calculator/__pycache__
echo "py-failing-tests: reset complete"
