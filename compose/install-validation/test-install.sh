#!/usr/bin/env bash
# compose/install-validation/test-install.sh
#
# Phase 8 Plan 08-14 / INSTALL-09 / D-38.
# Updated: Phase 16 Plan 16-03 / D-03 (bounded readiness loops) / D-06 (WSL2 posture).
# Updated: Phase 16 Plan 16-04 / D-04 (fatal doctor --json) / D-05 (vault setup) /
#          D-07 (unit-file content assertion).
#
# Runs INSIDE the systemd-Ubuntu container started by
# compose/install-validation/docker-compose.yml. Executes the README's
# install procedure literally as a non-root user ("coworker") and
# asserts every step exits 0:
#
#   0. Vault bootstrap    — brief serve run creates .jasper/ + app.db so
#                           vault-dependent doctor checks run (not skip)
#   1. `jasper install`   — registers + starts the systemd user unit
#   2. `jasper status`    — reports running (bounded retry loop, ~30s ceiling)
#   3. HTTP probe         — :PORT/api/v1/admin/status reachable (bounded retry loop)
#   4. Unit file content  — ExecStart=.../jasper serve + WantedBy=default.target (D-07)
#   5. `jasper doctor`    — fatal; all 12 checks ok via --json parse (D-04, D-05)
#   6. `jasper uninstall` — unit removed, port released
#
# WSL2 posture (D-06):
#   The container presents as WSL2 by default so doctor's checkWslSystemd
#   returns "ok" rather than "skip (native Linux — N/A)". The root preamble
#   below writes a fake osrelease containing "microsoft" and a wsl.conf with
#   [boot]/systemd=true. The coworker shell exports JASPER_OSRELEASE_PATH to
#   point at the fake file so the platform.OsreleasePath seam resolves it.

set -euo pipefail

# The jrei/systemd-ubuntu:noble base image ships neither sudo nor curl, but
# this harness needs both (sudo -u coworker for the non-root install; curl for
# the bounded HTTP readiness probes). Install them up front — this mirrors a
# real fresh-VM setup where a coworker would apt-install prerequisites. apt
# failure aborts loudly under set -e rather than flaking later.
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends sudo curl

# Create a non-root user to mimic a real coworker account.
useradd -m -s /bin/bash coworker
echo 'coworker ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/coworker
chmod 0440 /etc/sudoers.d/coworker

# Enable lingering so coworker's per-user systemd instance (and its D-Bus user
# bus) starts without an interactive login session. `jasper install` shells out
# to `systemctl --user enable --now`, which has no bus to talk to for a freshly
# `useradd`-ed user unless lingering is on — this is the same
# `loginctl enable-linger` step the WSL2 install docs require. NOTE: this needs
# a functioning systemd-logind. Emulated-amd64 hosts (e.g. Colima/Rosetta on
# macOS) where logind cannot start will fail here — this suite must run on a
# real Linux host / CI runner, which is its target environment anyway.
loginctl enable-linger coworker

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

# 0. Bootstrap a test vault so vault-dependent doctor checks run (not skip).
#    A brief serve run creates <vault>/.jasper/ + app.db (all migrations) and
#    writes current_vault into app.json. We then kill it and let jasper install
#    start the permanent systemd unit pointing at the same vault.
VAULT=/home/coworker/test-vault
mkdir -p "$VAULT"
/opt/jasper/bin/jasper serve --vault "$VAULT" &
VAULT_PID=$!
VAULT_READY=0
for i in $(seq 1 30); do
    if curl --max-time 2 -fsS "http://127.0.0.1:6683/api/v1/admin/status" >/dev/null 2>&1; then
        echo "vault bootstrapped (iter $i)"
        VAULT_READY=1
        break
    fi
    sleep 1
done
kill "$VAULT_PID" 2>/dev/null || true
wait "$VAULT_PID" 2>/dev/null || true
if [ "$VAULT_READY" -eq 0 ]; then
    echo "FAIL: vault bootstrap serve never became ready (30s timeout)" >&2
    exit 1
fi

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

# 3. Resolve the local port. This is a controlled container: the harness
#    creates the vault with defaults and never overrides server.port, so the
#    port is always the default 6683 (Plan 08-13) — and step 0's bootstrap
#    loop above already proved the server answers on 6683. We read it back
#    from the vault config defensively so a future default change is picked
#    up automatically; `|| true` keeps the 6683 fallback reachable under
#    `set -euo pipefail` (jq is not installed in the minimal noble image, so
#    we use grep, scoped to the "server" block to avoid matching mcp.port).
PORT=$(grep -A4 '"server"' "$VAULT/.jasper/config.json" 2>/dev/null \
       | grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]\+' \
       | grep -o '[0-9]\+' | head -1 || true)
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

# 4b. Assert jasper.service was written with the expected content (D-07).
#     ExecStart must end in "jasper serve" and [Install] must have
#     WantedBy=default.target — per backend/internal/installer/systemd_template.go.
UNIT_FILE="$HOME/.config/systemd/user/jasper.service"
if [[ ! -f "$UNIT_FILE" ]]; then
    echo "FAIL: jasper install did not create $UNIT_FILE" >&2
    exit 1
fi
if ! grep -q 'ExecStart=.*jasper serve' "$UNIT_FILE"; then
    echo "FAIL: $UNIT_FILE: ExecStart does not end in 'jasper serve'" >&2
    echo "  actual: $(grep ExecStart "$UNIT_FILE" || echo '(no ExecStart line)')" >&2
    exit 1
fi
if ! grep -q 'WantedBy=default.target' "$UNIT_FILE"; then
    echo "FAIL: $UNIT_FILE: WantedBy=default.target not found" >&2
    exit 1
fi
echo "jasper.service content ok (ExecStart=.../jasper serve, WantedBy=default.target)"

# 5. Doctor — fatal; every check must return "ok" (D-04, D-05).
#    Stop jasper first so net.Listen port probes (server.port, mcp.port) see
#    free ports — the naive net.Listen check can't distinguish "port owned by
#    jasper" from "port stolen by another process" without a health probe.
#    Permitted-skip set: empty. All 12 checks must be ok with vault + WSL posture.
#    Cobra prints the error to stderr on non-zero exit; stdout has the JSON array.
systemctl --user stop jasper 2>/dev/null || true

DOCTOR_RC=0
DOCTOR_JSON=$(/opt/jasper/bin/jasper doctor --json --vault "$VAULT") || DOCTOR_RC=$?
if [ "$DOCTOR_RC" -ne 0 ]; then
    echo "FAIL: jasper doctor --json exited $DOCTOR_RC (one or more checks failed)" >&2
    echo "$DOCTOR_JSON" >&2
    exit 1
fi
# Any "skip" in this posture is a configuration gap — fail loudly.
if echo "$DOCTOR_JSON" | grep -q '"status": "skip"'; then
    echo "FAIL: unexpected skip in doctor output (all 12 checks must be ok):" >&2
    echo "$DOCTOR_JSON" >&2
    exit 1
fi
echo "doctor passed — all checks ok"

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
