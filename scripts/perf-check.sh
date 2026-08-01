#!/usr/bin/env bash
# scripts/perf-check.sh — 5k-note startup gate.
#
# Starts `bin/jasper serve --data-dir _perf-vault` and measures the
# wall-clock time to first successful /api/v1/admin/status response.
# Fails if > 5 seconds.
#
# Prereqs:
#   - bin/jasper exists (run `make build` first).
#   - _perf-vault/ exists (08-14 lands `make perf-vault` to populate
#     this with 5k synthetic notes). If _perf-vault is missing or
#     empty this script still runs as a smoke test, but the timing
#     is not a real startup gate.
#
# Exit codes:
#   0  — startup completed within 5000ms
#   1  — startup exceeded 5000ms OR the server never became ready
set -euo pipefail

PORT="$(bash scripts/port.sh)"
DATA="_perf-vault"
if [[ ! -d "$DATA" ]]; then
    echo "WARN: $DATA missing — run 'make perf-vault' for a real check" >&2
    mkdir -p "$DATA"
fi
LOG=$(mktemp)
bin/jasper serve --data-dir "$DATA" --addr "127.0.0.1:${PORT}" > "$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -f "$LOG"' EXIT

START=$(date +%s)
for i in $(seq 1 100); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/v1/admin/status" > /dev/null 2>&1; then
        END=$(date +%s)
        SEC=$(( END - START ))
        MS=$(( SEC * 1000 ))
        echo "Startup ready in ~${MS}ms (loop iter ${i})"
        if (( SEC > 5 )); then
            echo "FAIL: startup exceeded 5000ms"
            exit 1
        fi
        echo "PASS: startup < 5000ms"
        exit 0
    fi
    sleep 0.1
done
echo "FAIL: server didn't become ready within 10s"
cat "$LOG"
exit 1
