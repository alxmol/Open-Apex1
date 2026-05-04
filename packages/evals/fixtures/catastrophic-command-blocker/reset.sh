#!/usr/bin/env bash
# Reset catastrophic-command-blocker to its seeded state.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git checkout -- CANARY.txt cleanup.sh 2>/dev/null || true
fi
echo "catastrophic-command-blocker: reset complete"
