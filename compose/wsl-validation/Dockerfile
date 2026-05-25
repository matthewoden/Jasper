# compose/wsl-validation/Dockerfile
#
# Two-stage build for the Docker-as-fake-WSL e2e harness.
#
# Stage 1 cross-compiles the jasper Go binary for linux/amd64 from the
# repo on the host. We rely on Go 1.24 (CGo-free thanks to
# modernc.org/sqlite — see PROJECT.md) so the build is hermetic and the
# resulting binary works in a minimal Alpine runtime.
#
# Stage 2 lays the binary into an Alpine image alongside the fake WSL
# infrastructure: a fixture directory tree that LOOKS like /mnt/c/Users/...
# and a fake osrelease file containing "microsoft" so the IsWSL() probe
# returns true. The container's command starts jasper serve with the
# JASPER_OSRELEASE_PATH env var pointing at the fake file.
#
# What this DOESN'T cover: anything that shells to a real wslpath /
# explorer.exe binary (e.g. the reveal handler in 08-05). Those are
# manually UAT-tested on a real WSL2 box. For the picker — which uses
# the pure-Go platform.WslToWindows converter — this harness is 1:1
# with real WSL2 behaviour for the /fs/list response shape.

FROM golang:1.24-alpine AS build
WORKDIR /src
# Pre-copy go.mod/go.sum first so docker layer cache reuses the dep
# download across iterations when only Go source changes.
COPY backend/go.mod backend/go.sum ./backend/
RUN cd backend && go mod download
COPY backend ./backend
COPY frontend/dist ./frontend/dist
# Embed pipeline: the frontend bundle MUST be at backend/internal/static/dist
# before `go build` runs (//go:embed all:dist). The Makefile's `build` target
# already copies frontend/dist → backend/internal/static/dist on the host;
# here we mirror that step so the container build doesn't need the host copy.
RUN mkdir -p backend/internal/static/dist \
    && cp -R frontend/dist/. backend/internal/static/dist/ \
    && touch backend/internal/static/dist/.keep
RUN cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -o /out/jasper ./cmd/jasper

FROM alpine:3.20 AS runtime
# - ca-certificates: cheap default, future-proofs outbound HTTPS calls.
# - curl: readiness probe in test-wsl.sh and CI.
# - socat: forwards the host-published port (0.0.0.0) into jasper's
#   loopback-only listener inside the container so we don't have to
#   weaken netbind.RequireLoopbackBind with a test-only escape hatch.
#   See entrypoint.sh.
RUN apk add --no-cache ca-certificates curl socat
COPY --from=build /out/jasper /usr/local/bin/jasper
COPY compose/wsl-validation/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Fake /proc/sys/kernel/osrelease — IsWSL() reads this file and looks for
# "microsoft" (case-insensitive). The container's actual /proc has the
# host Alpine kernel string, which would not contain "microsoft" — so we
# point JASPER_OSRELEASE_PATH at this file instead. The string mimics the
# canonical WSL2 kernel name so future code that parses it (none today)
# still works.
RUN mkdir -p /etc/jasper-wsl \
    && echo "5.15.167.4-microsoft-standard-WSL2" > /etc/jasper-wsl/osrelease

# Fixture tree that looks like a Windows C: drive. The vault picker
# enumerates these via os.ReadDir; the user's machine layout is irrelevant
# beyond "these directories exist and are readable."
RUN mkdir -p \
    /mnt/c/Users/jasper-test/Documents \
    /mnt/c/Users/jasper-test/Desktop \
    /mnt/c/Users/jasper-test/Downloads \
    /mnt/c/Users/jasper-test/Documents/Notes \
    /mnt/c/Users/jasper-test/Documents/Code \
    /mnt/c/Program\ Files

# Vault data lives outside /mnt/c so a creation step doesn't pollute the
# fixture. The container always boots into no-vault mode so the picker
# is what the test driver interacts with.
ENV JASPER_APP_HOME=/var/jasper-app
ENV JASPER_OSRELEASE_PATH=/etc/jasper-wsl/osrelease
RUN mkdir -p /var/jasper-app

# Two ports:
#   6683 (loopback inside the container) — what jasper actually listens on
#   6684 (0.0.0.0 inside the container)  — socat bridge that compose
#                                          publishes to the host.
# The bridge means the binary itself stays loopback-only — production
# guarantee preserved, no test-only override flag required.
EXPOSE 6684
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
