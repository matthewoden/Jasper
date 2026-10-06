#!/usr/bin/env bash
# scripts/vendor-graphos.sh — refresh api/graphql/graphos from a graphos checkout.
#
# Copies the shared Item contract and the shell subgraph's SDL, which
# compose-check composes Jasper against and graphql_test holds Jasper's
# shared declarations to. Commit the result with the graphos commit it names.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GRAPHOS="${GRAPHOS:-$ROOT/../graphos}"
OUT="$ROOT/api/graphql/graphos"
if [[ -n "$(git -C "$GRAPHOS" status --porcelain -- schema internal/shell)" ]]; then
    echo "vendor-graphos: $GRAPHOS has uncommitted schema changes" >&2
    exit 1
fi
mkdir -p "$OUT/shell"
cp "$GRAPHOS/schema/item.graphql" "$OUT/item.graphql"
cp "$GRAPHOS/internal/shell/stubs.graphql" "$OUT/shell/stubs.graphql"
cp "$GRAPHOS/internal/shell/schema.graphql" "$OUT/shell/schema.graphql"
git -C "$GRAPHOS" log -1 --format='%H %cs' >"$OUT/COMMIT"
echo "vendored graphos $(cut -c1-12 "$OUT/COMMIT")"
