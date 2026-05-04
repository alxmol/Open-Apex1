#!/usr/bin/env bash
# Fixture: infra-shell-heavy e2e runner.
# Exits nonzero until DATABASE_NAME is set (matching docker-compose.yml after fix).
set -euo pipefail

if [ -z "${DATABASE_NAME:-}" ]; then
  echo "ERROR: DATABASE_NAME is not set; cannot run e2e" >&2
  exit 1
fi

echo "e2e passes: DATABASE_NAME=$DATABASE_NAME"
exit 0
