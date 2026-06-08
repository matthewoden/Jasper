package vault

import (
	"path/filepath"
	"testing"
)

// TestVaultPaths exercises every helper exported by paths.go for two
// representative roots (a fixed absolute literal + a t.TempDir() value) and
// asserts the SubdirName constant is the exact load-bearing literal ".jasper"
// (D-06 — Phase 9 grep gate is calibrated against this value).
func TestVaultPaths(t *testing.T) {
	// SubdirName is load-bearing per ADR-001 §6 and D-06. Pin its literal value.
	if SubdirName != ".jasper" {
		t.Fatalf("SubdirName: want %q, got %q", ".jasper", SubdirName)
	}

	roots := []string{
		"/tmp/vault",
		t.TempDir(),
	}

	for _, root := range roots {
		root := root
		t.Run(root, func(t *testing.T) {
			tests := []struct {
				name string
				got  string
				want string
			}{
				{
					name: "AppDBPath",
					got:  AppDBPath(root),
					want: filepath.Join(root, ".jasper", "app.db"),
				},
				{
					name: "ConfigPath",
					got:  ConfigPath(root),
					want: filepath.Join(root, ".jasper", "config.json"),
				},
				{
					name: "LogsDir",
					got:  LogsDir(root),
					want: filepath.Join(root, ".jasper", "logs"),
				},
				{
					name: "LogsPath",
					got:  LogsPath(root),
					want: filepath.Join(root, ".jasper", "logs", "jasper.log"),
				},
				{
					name: "BackupPath",
					got:  BackupPath(root),
					want: filepath.Join(root, ".jasper", "app.db") + ".backup",
				},
				{
					name: "SeedGrantsPath",
					got:  SeedGrantsPath(root),
					want: filepath.Join(root, ".jasper", "seed_grants.json"),
				},
			}

			for _, tc := range tests {
				tc := tc
				t.Run(tc.name, func(t *testing.T) {
					if tc.got != tc.want {
						t.Fatalf("%s(%q): want %q, got %q", tc.name, root, tc.want, tc.got)
					}
				})
			}
		})
	}

	// BackupPath MUST be exactly AppDBPath(root) + ".backup" — the suffix lives
	// in one place. Assert the relationship structurally, not just by value.
	const probeRoot = "/v"
	if got, want := BackupPath(probeRoot), AppDBPath(probeRoot)+".backup"; got != want {
		t.Fatalf("BackupPath relationship: want %q (= AppDBPath+\".backup\"), got %q", want, got)
	}

	// LogsPath MUST be filepath.Join(LogsDir(root), "jasper.log") — the
	// "jasper.log" suffix lives in one place.
	if got, want := LogsPath(probeRoot), filepath.Join(LogsDir(probeRoot), "jasper.log"); got != want {
		t.Fatalf("LogsPath relationship: want %q (= LogsDir+jasper.log), got %q", want, got)
	}
}
