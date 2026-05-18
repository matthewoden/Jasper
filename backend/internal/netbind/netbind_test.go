package netbind

import (
	"strings"
	"testing"
)

func TestRequireLoopbackBind_AcceptsLoopback(t *testing.T) {
	cases := []string{
		"127.0.0.1:6683",
		"127.0.0.1:0",
		"127.0.0.1:3001", // arbitrary port accepted by the loopback gate (port-agnostic)
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
		":6683":            ":6683", // empty host = all interfaces; reject
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
	if !strings.Contains(err.Error(), `invalid --addr "not-an-addr"`) {
		t.Errorf("error did not mention invalid --addr: %v", err)
	}
}
