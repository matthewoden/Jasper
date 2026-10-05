#!/usr/bin/env bash
# scripts/compose-check.sh — does the subgraph compose with the stubs?
#
# Installs @apollo/composition into a scratch directory outside the repo (so
# frontend/package-lock.json is untouched) and runs compose-check.mjs. Needs
# network the first time; npm caches afterwards.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="${TMPDIR:-/tmp}/jasper-compose-check"
mkdir -p "$SCRATCH"
if [[ ! -d "$SCRATCH/node_modules/@apollo/composition" ]]; then
    (cd "$SCRATCH" && npm init -y >/dev/null && npm install --no-audit --no-fund --silent @apollo/composition@2.14.4 graphql@16)
fi
COMPOSE_NODE_MODULES="$SCRATCH/node_modules" node "$ROOT/scripts/compose-check.mjs" "$ROOT/api/graphql"
