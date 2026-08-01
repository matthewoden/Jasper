package netbind

import (
	"strings"
	"testing"
)

func TestRequireLoopbackBind_AcceptsLoopback(t *testing.T) {
	cases := []string{
		"127.0.0.1:6683",
		"127.0.0.1:0",
		"127.0.0.1:3001",
		"localhost:6683",
		"[::1]:6683",
	}
	for _, addr := range cases {
		if err := RequireLoopbackBind(addr); err != nil {
			t.Errorf("RequireLoopbackBind(%q): unexpected err: %v", addr, err)
		}
	}
}

func TestRequireLoopbackBind_RejectsExternal(t *testing.T) {
	cases := map[string]string{
		"0.0.0.0:6683":     "0.0.0.0:6683",
		"192.168.1.1:6683": "192.168.1.1:6683",
		"10.0.0.5:6683":    "10.0.0.5:6683",
		"example.com:6683": "example.com:6683",
		":6683":            ":6683",
	}
	for addr := range cases {
		err := RequireLoopbackBind(addr)
		if err == nil {
			t.Errorf("RequireLoopbackBind(%q): expected error, got nil", addr)
			continue
		}
		if !strings.Contains(err.Error(), "loopback") {
			t.Errorf("RequireLoopbackBind(%q): error did not mention loopback: %v", addr, err)
		}
	}
}

func TestRequireLoopbackBind_RejectsMalformed(t *testing.T) {
	err := RequireLoopbackBind("not-an-addr")
	if err == nil {
		t.Fatal("expected error for malformed addr, got nil")
	}
	if !strings.Contains(err.Error(), `invalid --bind "not-an-addr"`) {
		t.Errorf("error did not mention invalid --bind: %v", err)
	}
}

// TestHostAllowlist_LoopbackBind: under the default loopback bind the three
// loopback spellings pass and an attacker-controlled name is rejected. This
// is the DNS-rebinding gate — after a rebind the connection looks
// legitimate and only the Host header still names the attacker.
func TestHostAllowlist_LoopbackBind(t *testing.T) {
	a := NewHostAllowlist("127.0.0.1:6683")

	for _, host := range []string{
		"127.0.0.1:6683", "localhost:6683", "[::1]:6683",
		"LOCALHOST:6683", "127.0.0.1", "localhost:5173",
	} {
		if !a.Allows(host) {
			t.Errorf("Allows(%q) = false, want true", host)
		}
	}
	for _, host := range []string{
		"evil.com:6683", "evil.com", "notes.localhost.evil.com:6683",
		"192.168.1.5:6683", "",
	} {
		if a.Allows(host) {
			t.Errorf("Allows(%q) = true, want false", host)
		}
	}
}

// TestHostAllowlist_ExplicitBind: --bind names a reachable host, so that
// host joins the allowlist (ADR-0014 keeps the flag working) without
// admitting anything else.
func TestHostAllowlist_ExplicitBind(t *testing.T) {
	a := NewHostAllowlist("192.168.1.5:6683")

	for _, host := range []string{"192.168.1.5:6683", "127.0.0.1:6683", "localhost:6683"} {
		if !a.Allows(host) {
			t.Errorf("Allows(%q) = false, want true", host)
		}
	}
	if a.Allows("evil.com:6683") {
		t.Error(`Allows("evil.com:6683") = true, want false`)
	}
}

// TestHostAllowlist_AllInterfacesBind: a 0.0.0.0 bind cannot name its
// reachable address in advance, so any IP-literal Host passes. Rebinding
// always arrives under a DNS name, so names stay rejected.
func TestHostAllowlist_AllInterfacesBind(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:6683", "[::]:6683"} {
		a := NewHostAllowlist(addr)
		for _, host := range []string{"192.168.1.5:6683", "10.0.0.9", "[fe80::1]:6683", "localhost:6683"} {
			if !a.Allows(host) {
				t.Errorf("bind %s: Allows(%q) = false, want true", addr, host)
			}
		}
		for _, host := range []string{"evil.com:6683", "jasper.local:6683", ""} {
			if a.Allows(host) {
				t.Errorf("bind %s: Allows(%q) = true, want false", addr, host)
			}
		}
	}
}

// TestLoopbackHostAllowlist_HasNoLANEscape covers the MCP listener,
// which is loopback-enforced with no opt-out (ADR-0013 / CONTEXT invariant 5)
// — so unlike the HTTP listener there is no bind case that widens it.
func TestLoopbackHostAllowlist_HasNoLANEscape(t *testing.T) {
	a := LoopbackHostAllowlist()

	for _, host := range []string{"127.0.0.1:6684", "localhost:6684", "[::1]:6684"} {
		if !a.Allows(host) {
			t.Errorf("Allows(%q) = false, want true", host)
		}
	}
	for _, host := range []string{"evil.com:6684", "192.168.1.5:6684", ""} {
		if a.Allows(host) {
			t.Errorf("Allows(%q) = true, want false", host)
		}
	}
}
