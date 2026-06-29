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

cleanup() {
    echo "==> Tearing down compose/install-validation suite"
    $COMPOSE down --volumes --remove-orphans
}
trap cleanup EXIT

echo "==> Starting compose/install-validation suite"
$COMPOSE up -d

echo "==> Waiting for systemd to become ready (24 x 5 s)"
for i in $(seq 1 24); do
    if $COMPOSE exec -T jasper-install-test \
           systemctl is-system-running --quiet --wait 2>/dev/null; then
        echo "systemd ready (iter $i)"
        break
    fi
    if [ "$i" -eq 24 ]; then
        echo "FAIL: systemd never became ready after 120 s" >&2
        $COMPOSE logs >&2
        exit 1
    fi
    sleep 5
done

echo "==> Running test-install.sh inside the container"
$COMPOSE exec -T jasper-install-test bash /opt/jasper/test-install.sh

echo "==> PASS: install-validation suite complete"
