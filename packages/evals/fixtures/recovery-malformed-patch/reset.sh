#!/usr/bin/env bash
# Reset recovery-malformed-patch to its seeded state.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

# Restore the seeded file from git index.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git checkout -- src/lib.py 2>/dev/null || true
fi

# Wipe python caches.
rm -rf .pytest_cache __pycache__ src/__pycache__
echo "recovery-malformed-patch: reset complete"
