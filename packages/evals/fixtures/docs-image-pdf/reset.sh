#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git checkout -- canary.png canary.pdf 2>/dev/null || true
fi
echo "docs-image-pdf: reset complete"
