#!/usr/bin/env bash
# compose/install-validation/run.sh
# Phase 16 Plan 16-05 / D-08: shared compose invocation sequence for the
# systemd install-validation suite.
#
# Called by BOTH:
#   - `make test-systemd-e2e`  (local one-command harness — Makefile)
#   - `.github/workflows/install-validation.yml`  (CI Linux runner)
#
# Having a single shared script means the two callers cannot drift from each
# other (threat T-16-10). Neither caller re-lists the compose commands inline.
#
# MUST be invoked from the repository root (where compose/ and bin/ live).
# Docker resolves volume paths in docker-compose.yml relative to the compose
# file's location (compose/install-validation/), so repo-root CWD is correct.

set -euo pipefail

COMPOSE="docker compose -f compose/install-validation/docker-compose.yml"

# Without this, a missing cross-compiled binary lets Docker create the bind-mount
# source as an empty directory, and the failure only surfaces later as a missing
# binary inside the container.
LINUX_BIN="bin/linux-amd64/jasper"
if [ ! -x "$LINUX_BIN" ]; then
    echo "FAIL: $LINUX_BIN missing or not executable — run \`make test-systemd-e2e\`, which cross-compiles it first, rather than invoking run.sh directly." >&2
    exit 1
fi

cleanup() {
    echo "==> Tearing down compose/install-validation suite"
    $COMPOSE down --volumes --remove-orphans
}
trap cleanup EXIT

echo "==> Starting compose/install-validation suite"
$COMPOSE up -d

echo "==> Waiting for systemd to become ready (24 x 5 s)"
# Accept "running" OR "degraded": degraded means boot finished but a
# non-essential unit (commonly systemd-journald in a container) failed — the
# system is still usable. `is-system-running --wait` exits non-zero on
# degraded, so we poll the state string ourselves instead of trusting exit code.
for i in $(seq 1 24); do
    STATE=$($COMPOSE exec -T jasper-install-test systemctl is-system-running 2>/dev/null || true)
    if echo "$STATE" | grep -Eq '^(running|degraded)$'; then
        echo "systemd ready (state=$STATE, iter $i)"
        break
    fi
    if [ "$i" -eq 24 ]; then
        echo "FAIL: systemd never became ready after 120 s (last state: ${STATE:-unknown})" >&2
        $COMPOSE logs >&2
        exit 1
    fi
    sleep 5
done

echo "==> Running test-install.sh inside the container"
$COMPOSE exec -T jasper-install-test bash /opt/jasper/test-install.sh

echo "==> PASS: install-validation suite complete"
