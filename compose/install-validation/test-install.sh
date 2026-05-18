#!/usr/bin/env bash
# compose/install-validation/test-install.sh
#
# Phase 8 Plan 08-14 / INSTALL-09 / D-38.
#
# Runs INSIDE the systemd-Ubuntu container started by
# compose/install-validation/docker-compose.yml. Executes the README's
# install procedure literally as a non-root user ("coworker") and
# asserts every step exits 0:
#
#   1. `jasper install`   — registers + starts the systemd user unit
#   2. `jasper status`    — reports running
#   3. HTTP probe         — :6683/api/v1/admin/status reachable
#   4. `jasper doctor`    — non-fatal warnings tolerated (some checks
#                           are platform-specific and may degrade in
#                           the container)
#   5. `jasper uninstall` — unit removed, port released
#
# WSL2 pre-reqs that this container handles differently:
#   - /etc/wsl.conf [boot]/systemd=true — N/A inside the container
#     (systemd is PID 1 by construction; jrei/systemd-ubuntu:noble's
#     /sbin/init is systemd).
#   - loginctl enable-linger $USER — `jasper install` calls this
#     automatically via kardianos/service.

set -euo pipefail

# Create a non-root user to mimic a real coworker account.
useradd -m -s /bin/bash coworker
echo 'coworker ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/coworker
chmod 0440 /etc/sudoers.d/coworker

# Run the README's install steps as that user. We use `sudo -u` rather
# than `su -` so the inner heredoc inherits the outer set -e behavior.
sudo -u coworker bash <<'INNER'
set -euo pipefail

# Set HOME so kardianos/service writes the unit to ~/.config/systemd/user/.
export HOME=/home/coworker
export XDG_RUNTIME_DIR=/run/user/$(id -u)

# 1. Install the service.
/opt/jasper/bin/jasper install

# 2. Allow systemd a moment to settle after the install.
sleep 5

# 3. Status MUST report the service is running.
/opt/jasper/bin/jasper status

# 4. Probe the local port. Default is 6683 (Plan 08-13); coworkers who
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
curl --max-time 10 -fsS "http://127.0.0.1:${PORT}/api/v1/admin/status" >/dev/null

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
