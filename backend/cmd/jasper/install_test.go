package main

import (
	"errors"
	"testing"
)

// TestIsAlreadyInstalled covers the substring sentinel detection used
// by runInstall to soften kardianos's duplicate-install error into a
// continue path.
func TestIsAlreadyInstalled(t *testing.T) {
	cases := []struct {
		name string
		in   error
		want bool
	}{
		{"nil", nil, false},
		{"already installed lowercase", errors.New("service already installed"), true},
		{"already installed mixed case", errors.New("Service Already Installed"), true},
		{"file exists", errors.New("file exists at /Library/.../plist"), true},
		{"unrelated permission error", errors.New("permission denied"), false},
		{"empty message", errors.New(""), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isAlreadyInstalled(tc.in); got != tc.want {
				t.Errorf("isAlreadyInstalled(%v) = %v; want %v", tc.in, got, tc.want)
			}
		})
	}
}

// TestInstallCmd_Registered pins that the install subcommand is wired
// onto rootCmd via init().
func TestInstallCmd_Registered(t *testing.T) {
	found := false
	for _, c := range rootCmd.Commands() {
		if c.Use == "install" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("installCmd not registered on rootCmd")
	}
}

// TestUninstallCmd_Registered pins that the uninstall subcommand is
// wired onto rootCmd via init().
func TestUninstallCmd_Registered(t *testing.T) {
	found := false
	for _, c := range rootCmd.Commands() {
		if c.Use == "uninstall" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("uninstallCmd not registered on rootCmd")
	}
}
