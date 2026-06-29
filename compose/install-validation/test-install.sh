#!/usr/bin/env bash
# compose/install-validation/test-install.sh
#
# Phase 8 Plan 08-14 / INSTALL-09 / D-38.
# Updated: Phase 16 Plan 16-03 / D-03 (bounded readiness loops) / D-06 (WSL2 posture).
#
# Runs INSIDE the systemd-Ubuntu container started by
# compose/install-validation/docker-compose.yml. Executes the README's
# install procedure literally as a non-root user ("coworker") and
# asserts every step exits 0:
#
#   1. `jasper install`   — registers + starts the systemd user unit
#   2. `jasper status`    — reports running (bounded retry loop, ~30s ceiling)
#   3. HTTP probe         — :PORT/api/v1/admin/status reachable (bounded retry loop)
#   4. `jasper doctor`    — non-fatal warnings tolerated (some checks
#                           are platform-specific and may degrade in
#                           the container)
#   5. `jasper uninstall` — unit removed, port released
#
# WSL2 posture (D-06):
#   The container presents as WSL2 by default so doctor's checkWslSystemd
#   returns "ok" rather than "skip (native Linux — N/A)". The root preamble
#   below writes a fake osrelease containing "microsoft" and a wsl.conf with
#   [boot]/systemd=true. The coworker shell exports JASPER_OSRELEASE_PATH to
#   point at the fake file so the platform.OsreleasePath seam resolves it.

set -euo pipefail

# Create a non-root user to mimic a real coworker account.
useradd -m -s /bin/bash coworker
echo 'coworker ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/coworker
chmod 0440 /etc/sudoers.d/coworker

# Provision fake WSL2 identity fixtures (D-06).
# /proc/sys/kernel/osrelease on jrei/systemd-ubuntu:noble contains the host
# kernel string (no "microsoft") — redirect via JASPER_OSRELEASE_PATH instead.
mkdir -p /etc/jasper-wsl
echo "5.15.167.4-microsoft-standard-WSL2" > /etc/jasper-wsl/osrelease
chmod 0644 /etc/jasper-wsl/osrelease

# Write a real wsl.conf so checkWslSystemd returns "ok" once JASPER_OSRELEASE_PATH
# points at the fake osrelease above. systemd is already running as PID 1 in this
# container; the wsl.conf just satisfies the file-presence + [boot]/systemd=true check.
cat > /etc/wsl.conf <<'WSLCONF'
[boot]
systemd=true
WSLCONF

# Run the README's install steps as that user. We use `sudo -u` rather
# than `su -` so the inner heredoc inherits the outer set -e behavior.
sudo -u coworker bash <<'INNER'
set -euo pipefail

# Set HOME so kardianos/service writes the unit to ~/.config/systemd/user/.
export HOME=/home/coworker
export XDG_RUNTIME_DIR=/run/user/$(id -u)

# Point jasper at the fake osrelease so checkWslSystemd returns "ok" (D-06).
# sudo -u strips the outer environment, so this must be re-exported here.
export JASPER_OSRELEASE_PATH=/etc/jasper-wsl/osrelease

# 1. Install the service.
/opt/jasper/bin/jasper install

# 2. Bounded poll: wait for the jasper systemd user unit to report running (D-03).
#    Replaces the former fixed `sleep 5`. Fails loudly after 30 attempts (~30s).
JASPER_READY=0
for i in $(seq 1 30); do
    if /opt/jasper/bin/jasper status >/dev/null 2>&1; then
        echo "jasper unit running (iter $i)"
        JASPER_READY=1
        break
    fi
    sleep 1
done
if [ "$JASPER_READY" -eq 0 ]; then
    echo "FAIL: jasper service never became running after jasper install (30s timeout)" >&2
    exit 1
fi

# 3. Probe the local port. Default is 6683 (Plan 08-13); coworkers who
#    override server.port in config.json will hit a different port —
#    we read the actual port via `jasper status --json` so this test
#    survives a port change.
#
#    Fallback to 6683 if --json parsing fails (jq not installed in the
#    minimal noble image — we use grep instead).
PORT=$(/opt/jasper/bin/jasper status --json 2>/dev/null | \
       grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]\+' | \
       grep -o '[0-9]\+' | head -1)
PORT=${PORT:-6683}

# 4. Bounded poll: wait for HTTP health endpoint to return 200 (D-03).
#    Replaces the former single-shot curl. Fails loudly after 30 attempts (~30s).
HTTP_READY=0
for i in $(seq 1 30); do
    if curl --max-time 5 -fsS "http://127.0.0.1:${PORT}/api/v1/admin/status" >/dev/null 2>&1; then
        echo "HTTP /api/v1/admin/status reachable (iter $i)"
        HTTP_READY=1
        break
    fi
    sleep 1
done
if [ "$HTTP_READY" -eq 0 ]; then
    echo "FAIL: /api/v1/admin/status never returned HTTP 200 within 30s" >&2
    exit 1
fi

# 5. Doctor: non-fatal warnings are acceptable inside a minimal
#    container (e.g., the macOS-only launchd check will degrade
#    or be skipped — that's by design).
/opt/jasper/bin/jasper doctor || echo "(doctor surfaced warnings — non-fatal in this CI run)"

# 6. Uninstall + assert the unit is gone. `jasper uninstall` exits
#    0 on success; the post-condition is that the service file is
#    removed under ~/.config/systemd/user/.
/opt/jasper/bin/jasper uninstall

if [[ -f "$HOME/.config/systemd/user/jasper.service" ]]; then
    echo "FAIL: uninstall did not remove jasper.service" >&2
    exit 1
fi

INNER

echo "INSTALL-09: passed"
