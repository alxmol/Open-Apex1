#!/usr/bin/env bash
# Reset node-lint-build-test to its seeded-failure state.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git checkout -- src tests package.json tsconfig.json eslint.config.js 2>/dev/null || true
fi

rm -rf node_modules .bun dist
echo "node-lint-build-test: reset complete"
