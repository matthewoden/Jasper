package main

import (
	"strings"
	"testing"
)

func TestRequireLoopbackBind_AcceptsLoopback(t *testing.T) {
	good := []string{
		"127.0.0.1:3000",
		"127.0.0.1:0",
		"127.0.0.1:3001", // dev backend per .air.toml D-13
		"localhost:3000",
		"[::1]:3000",
	}
	for _, addr := range good {
		if err := requireLoopbackBind(addr); err != nil {
			t.Errorf("requireLoopbackBind(%q): unexpected err: %v", addr, err)
		}
	}
}

func TestRequireLoopbackBind_RejectsExternal(t *testing.T) {
	bad := []string{
		"0.0.0.0:3000",
		"192.168.1.10:3000",
		"10.0.0.5:3000",
		"example.com:3000",
		":3000", // empty host = all interfaces; reject (forces explicit loopback)
	}
	for _, addr := range bad {
		err := requireLoopbackBind(addr)
		if err == nil {
			t.Errorf("requireLoopbackBind(%q): expected error, got nil", addr)
			continue
		}
		if !strings.Contains(err.Error(), "loopback") {
			t.Errorf("requireLoopbackBind(%q): error did not mention loopback: %v", addr, err)
		}
	}
}

func TestRequireLoopbackBind_RejectsMalformed(t *testing.T) {
	// SplitHostPort errors on missing port; we wrap that into "invalid --addr".
	err := requireLoopbackBind("not-a-host-port")
	if err == nil {
		t.Fatal("expected error for malformed addr, got nil")
	}
	if !strings.Contains(err.Error(), "invalid --addr") {
		t.Errorf("error did not mention invalid --addr: %v", err)
	}
}
