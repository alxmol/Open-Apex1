#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git checkout -- . 2>/dev/null || true
fi
find . -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
find . -name target -prune -exec rm -rf {} + 2>/dev/null || true
echo "mixed-monorepo: reset complete"
