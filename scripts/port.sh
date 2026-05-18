#!/usr/bin/env bash
# scripts/port.sh — canonical source for `server.port`.
#
# Read by .air.toml, vite.config.ts, Playwright config, smoke tests,
# and Makefile `print-port` / `perf-check` targets. Single source of
# truth so dev (air + Vite proxy) and prod (the installed binary)
# stay in parity (Phase 8 D-40 / D-41).
#
# Looks at $JASPER_CONFIG (or ~/.jasper/storage/config.json by default).
# If present, prints `server.port` (jq if available, grep fallback).
# If absent, prints the default 6683 (T9 keypad for "NOTE").

set -euo pipefail
CONFIG="${JASPER_CONFIG:-$HOME/.jasper/storage/config.json}"
DEFAULT_PORT=6683

if [[ -f "$CONFIG" ]]; then
    if command -v jq >/dev/null 2>&1; then
        jq -r ".server.port // $DEFAULT_PORT" "$CONFIG"
    else
        # grep fallback for systems without jq.
        grep -E '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$CONFIG" | head -1 | grep -oE '[0-9]+' || echo "$DEFAULT_PORT"
    fi
else
    echo "$DEFAULT_PORT"
fi
