package main

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
		{"127.0.0.1:6683", true, "IPv4 loopback"},
		{"localhost:6683", true, "hostname loopback"},
		{"[::1]:6683", true, "IPv6 loopback"},
		{"127.0.0.1:0", true, "ephemeral port on loopback"},

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

			if !tc.wantOK && err != nil && !strings.Contains(err.Error(), "loopback") {
				t.Errorf("addr=%q: error did not mention loopback: %v", tc.addr, err)
			}
		})
	}
}

// TestServeWSLBindOptIn documents the WSL2 0.0.0.0 acceptance path.
//
// There is no env-var or build-tag opt-in to RequireLoopbackBind: users who
// need LAN access on WSL2 must explicitly edit server.bind in config.json, and
// the loopback gate refuses startup. This test documents the absence of any
// silent escape hatch; if one is added to netbind.go, a case can be added here.
func TestServeWSLBindOptIn(t *testing.T) {
	t.Setenv("JASPER_ALLOW_WSL_BIND", "1")
	if err := netbind.RequireLoopbackBind("0.0.0.0:6683"); err == nil {
		t.Errorf("RequireLoopbackBind(0.0.0.0:6683) with JASPER_ALLOW_WSL_BIND=1: " +
			"expected refusal (no silent env opt-in), got nil")
	}

	_ = os.Unsetenv("JASPER_ALLOW_WSL_BIND")
	if err := netbind.RequireLoopbackBind("0.0.0.0:6683"); err == nil {
		t.Errorf("RequireLoopbackBind(0.0.0.0:6683): expected refusal, got nil")
	}
}
