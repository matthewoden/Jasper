#!/bin/sh
# Boots jasper on container loopback (127.0.0.1:6683) and bridges the
# host-published port (0.0.0.0:6684) into it via socat. The bridge is the
# reason the binary stays genuinely loopback-only — production's
# netbind.RequireLoopbackBind contract is never relaxed for the test
# harness.
#
# Process model:
#   PID 1: this shell script → exec socat (becomes PID 1 itself)
#   child: jasper serve, started in the background
#
# On signal, the kernel delivers to PID 1 (socat). socat exits → script
# falls through. We propagate the signal to jasper explicitly so the
# Go server gets a chance to shut its DB pair cleanly.

set -e

JASPER_PORT=6683
BRIDGE_PORT=6684

cleanup() {
  if [ -n "${JASPER_PID:-}" ]; then
    kill -TERM "$JASPER_PID" 2>/dev/null || true
    wait "$JASPER_PID" 2>/dev/null || true
  fi
}
trap cleanup TERM INT EXIT

# Background the server. JASPER_OSRELEASE_PATH is set in the Dockerfile so
# IsWSL() returns true at every probe.
jasper serve --addr "127.0.0.1:${JASPER_PORT}" &
JASPER_PID=$!

# Wait for the listener to accept before publishing the bridge. Avoids
# Playwright connecting to a forwarder that's pointed at a dead port.
i=0
while ! curl -fsS "http://127.0.0.1:${JASPER_PORT}/api/v1/vault/recent" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "entrypoint.sh: jasper did not become ready after 30s" >&2
    exit 1
  fi
  # Confirm the server hasn't died while we wait — otherwise we'd loop
  # forever against a dead PID.
  if ! kill -0 "$JASPER_PID" 2>/dev/null; then
    echo "entrypoint.sh: jasper exited during startup; see logs above" >&2
    exit 1
  fi
  sleep 0.5
done

echo "entrypoint.sh: jasper ready on 127.0.0.1:${JASPER_PORT}; bridging 0.0.0.0:${BRIDGE_PORT}"
# `fork` so multiple Playwright sessions can connect; `reuseaddr` so a
# rapid `docker compose down && up` doesn't hit TIME_WAIT.
exec socat "TCP-LISTEN:${BRIDGE_PORT},fork,reuseaddr" "TCP:127.0.0.1:${JASPER_PORT}"
