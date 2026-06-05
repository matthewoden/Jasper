#!/usr/bin/env bash
# strip-comments-run.sh — driver that builds + runs both strippers
# across the in-scope trees and prints combined counts.
#
# Usage:
#   scripts/strip-comments-run.sh dry    # report only, no writes
#   scripts/strip-comments-run.sh apply  # actually rewrite files
set -euo pipefail

MODE="${1:-dry}"
DRY_FLAG=""
if [[ "${MODE}" == "dry" ]]; then
  DRY_FLAG="--dry"
elif [[ "${MODE}" == "apply" ]]; then
  DRY_FLAG=""
else
  echo "usage: $0 [dry|apply]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

mkdir -p bin

echo "[strip-comments-run] building Go stripper..."
(cd scripts/strip-comments-go && go build -o "${ROOT}/bin/strip-comments-go" ./...)

echo "[strip-comments-run] Go sweep over backend/ (mode=${MODE})"
"${ROOT}/bin/strip-comments-go" --root backend ${DRY_FLAG} 2>&1 | tee "${TMPDIR:-/tmp}/strip-go-${MODE}.log"

echo "[strip-comments-run] JS sweep over frontend/src (mode=${MODE})"
node "${ROOT}/scripts/strip-comments-js.mjs" --root frontend/src ${DRY_FLAG} 2>&1 | tee "${TMPDIR:-/tmp}/strip-js-src-${MODE}.log"

echo "[strip-comments-run] JS sweep over frontend/e2e (mode=${MODE})"
node "${ROOT}/scripts/strip-comments-js.mjs" --root frontend/e2e ${DRY_FLAG} 2>&1 | tee "${TMPDIR:-/tmp}/strip-js-e2e-${MODE}.log"

# Top-level frontend configs.
echo "[strip-comments-run] JS sweep over frontend/*.{ts,js,mjs,cjs} configs"
shopt -s nullglob
configs=(frontend/*.ts frontend/*.js frontend/*.mjs frontend/*.cjs)
shopt -u nullglob
if (( ${#configs[@]} > 0 )); then
  node "${ROOT}/scripts/strip-comments-js.mjs" ${DRY_FLAG} "${configs[@]}" 2>&1 | tee "${TMPDIR:-/tmp}/strip-js-cfg-${MODE}.log"
fi

echo "[strip-comments-run] DONE (mode=${MODE})"
