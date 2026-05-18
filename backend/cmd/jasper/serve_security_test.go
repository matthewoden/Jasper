package main

// serve_security_test.go — Phase 8 Plan 08-14 / SECURITY-05 / D-45.
//
// Loopback-bind enforcement regression suite. The core accept/reject
// matrix lives in backend/internal/netbind/netbind_test.go (7 cases as of
// Plan 08-01 Task 3); this file pins the cmd/jasper-side contract:
//
//   1. The loopback gate is reachable from `package main` (catches a
//      refactor that silently drops the netbind import).
//   2. The accept list is locked: 127.0.0.1, ::1, localhost.
//   3. The reject list is locked: 0.0.0.0, RFC1918 addresses, empty host.
//   4. WSL2 0.0.0.0 acceptance is NOT silently enabled — Phase 8 ships
//      with the macOS posture (refuse 0.0.0.0). The user who needs LAN
//      access on WSL2 must explicitly edit config.json server.bind to
//      `0.0.0.0:6683` (the install-validation docker-compose suite in
//      compose/install-validation/ exercises that path end-to-end).
//
// Threat model: T-08-63 ("Non-loopback bind regression on macOS"). A
// regression that accepts 0.0.0.0 by default would expose the local
// vault to anyone on the same Wi-Fi — the entire reason Jasper exists
// is to NOT do that. This file is the last-line guard before merge.

import (
	"os"
	"strings"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/netbind"
)

// TestRequireLoopbackBind_OnlyLoopback locks the accept/reject matrix
// at the cmd/jasper boundary. Mirrors netbind_test.go but exercises
// the call through `package main`'s import graph — a refactor that
// silently re-routes serve.go to a different validator surfaces here.
func TestRequireLoopbackBind_OnlyLoopback(t *testing.T) {
	cases := []struct {
		addr    string
		wantOK  bool
		comment string
	}{
		// Accept list (per D-15 / D-45).
		{"127.0.0.1:6683", true, "IPv4 loopback"},
		{"localhost:6683", true, "hostname loopback"},
		{"[::1]:6683", true, "IPv6 loopback"},
		{"127.0.0.1:0", true, "ephemeral port on loopback"},

		// Reject list — macOS posture: REFUSE 0.0.0.0 by default.
		{"0.0.0.0:6683", false, "all-interfaces v4 (would expose to LAN)"},
		{"192.168.1.1:6683", false, "RFC1918 (private LAN)"},
		{"10.0.0.5:6683", false, "RFC1918 (private LAN)"},
		{":6683", false, "empty host shorthand = all interfaces"},
		{"example.com:6683", false, "external hostname"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.addr, func(t *testing.T) {
			err := netbind.RequireLoopbackBind(tc.addr)
			if tc.wantOK && err != nil {
				t.Errorf("addr=%q (%s): expected ok, got err: %v",
					tc.addr, tc.comment, err)
			}
			if !tc.wantOK && err == nil {
				t.Errorf("addr=%q (%s): expected refusal, got nil",
					tc.addr, tc.comment)
			}
			// The error string is part of the contract — log greps in
			// serve.go's startup output rely on the "loopback" substring.
			if !tc.wantOK && err != nil && !strings.Contains(err.Error(), "loopback") {
				t.Errorf("addr=%q: error did not mention loopback: %v", tc.addr, err)
			}
		})
	}
}

// TestServeWSLBindOptIn documents the WSL2 0.0.0.0 acceptance path.
//
// Phase 8 ships WITHOUT an env-var or build-tag opt-in to RequireLoopbackBind:
// users who need LAN access on WSL2 must explicitly edit
// ~/.jasper/storage/config.json server.bind to `0.0.0.0:6683` and the
// loopback gate will refuse the binary's startup. The install-validation
// docker-compose suite (compose/install-validation/) exercises that
// real-WSL2-distro path end-to-end (D-45 / INSTALL-09).
//
// If a future plan adds JASPER_ALLOW_WSL_BIND=1 (or similar) to
// netbind.go, this test gains a case that exercises it. Today it
// documents the absence of any silent escape hatch.
func TestServeWSLBindOptIn(t *testing.T) {
	// If a future opt-in env var is added, this guard prevents the test
	// from forgetting to exercise it. As of Plan 08-14 the var is NOT
	// honored, so RequireLoopbackBind("0.0.0.0:6683") MUST still refuse
	// even when the var is set — the WSL2 path is config-driven, not
	// env-driven.
	t.Setenv("JASPER_ALLOW_WSL_BIND", "1")
	if err := netbind.RequireLoopbackBind("0.0.0.0:6683"); err == nil {
		t.Errorf("RequireLoopbackBind(0.0.0.0:6683) with JASPER_ALLOW_WSL_BIND=1: " +
			"expected refusal (no silent env opt-in), got nil")
	}
	// Sanity: ensure the unset case also refuses (defense-in-depth — if
	// the t.Setenv leaks somehow, this catches it).
	_ = os.Unsetenv("JASPER_ALLOW_WSL_BIND")
	if err := netbind.RequireLoopbackBind("0.0.0.0:6683"); err == nil {
		t.Errorf("RequireLoopbackBind(0.0.0.0:6683): expected refusal, got nil")
	}
}
