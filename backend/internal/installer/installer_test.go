package installer

import (
	"runtime"
	"strings"
	"testing"
	"text/template"
)

// TestLaunchdTemplateKeepAliveCrashedDict pins the dict-form KeepAlive in
// the launchd template. The kardianos default emits the bool form
// `<key>KeepAlive</key><true/>` which restarts on graceful `launchctl bootout`
// and breaks `jasper uninstall`. We assert the dict form is present and the
// bool-only form is absent.
func TestLaunchdTemplateKeepAliveCrashedDict(t *testing.T) {
	if !strings.Contains(launchdPlist, "<key>KeepAlive</key>\n    <dict>") {
		t.Errorf("launchdPlist missing dict-form KeepAlive (got bool-form or missing entirely)")
	}
	if !strings.Contains(launchdPlist, "<key>Crashed</key>\n        <true/>") {
		t.Errorf("launchdPlist missing <key>Crashed</key> with <true/> body")
	}
	if !strings.Contains(launchdPlist, "<key>SuccessfulExit</key>\n        <false/>") {
		t.Errorf("launchdPlist missing <key>SuccessfulExit</key> with <false/> body")
	}

	bad := "<key>KeepAlive</key>\n    <true/>"
	if strings.Contains(launchdPlist, bad) {
		t.Errorf("launchdPlist contains bool-form KeepAlive (regression!): %q", bad)
	}
}

// TestLaunchdTemplateThrottleInterval pins ThrottleInterval=60 in the
// launchd template.
func TestLaunchdTemplateThrottleInterval(t *testing.T) {
	if !strings.Contains(launchdPlist, "<key>ThrottleInterval</key>") {
		t.Errorf("launchdPlist missing <key>ThrottleInterval</key>")
	}
	if !strings.Contains(launchdPlist, "<integer>60</integer>") {
		t.Errorf("launchdPlist missing <integer>60</integer> ThrottleInterval value")
	}
}

// TestLaunchdTemplateProcessTypeInteractive pins the LaunchAgent
// best-practice ProcessType field (macOS 10.10+).
func TestLaunchdTemplateProcessTypeInteractive(t *testing.T) {
	if !strings.Contains(launchdPlist, "<key>ProcessType</key>") {
		t.Errorf("launchdPlist missing <key>ProcessType</key>")
	}
	if !strings.Contains(launchdPlist, "<string>Interactive</string>") {
		t.Errorf("launchdPlist missing ProcessType=Interactive")
	}
}

// TestLaunchdTemplateRunAtLoadAndServeArg sanity-checks the rest of the
// plist body: RunAtLoad=true and `serve` argument are both present so
// the LaunchAgent actually starts the server.
func TestLaunchdTemplateRunAtLoadAndServeArg(t *testing.T) {
	if !strings.Contains(launchdPlist, "<key>RunAtLoad</key>\n    <true/>") {
		t.Errorf("launchdPlist missing RunAtLoad=true")
	}
	if !strings.Contains(launchdPlist, "<string>serve</string>") {
		t.Errorf("launchdPlist missing `serve` argument")
	}
}

// TestSystemdTemplateRestartOnFailure pins Restart=on-failure in the systemd
// template (NOT the kardianos default `Restart=always`).
func TestSystemdTemplateRestartOnFailure(t *testing.T) {
	if !strings.Contains(systemdUnit, "Restart=on-failure") {
		t.Errorf("systemdUnit missing Restart=on-failure (kardianos default `always` would silently respawn after SIGTERM)")
	}

	if strings.Contains(systemdUnit, "Restart=always") {
		t.Errorf("systemdUnit contains Restart=always — must be on-failure")
	}
}

// TestSystemdTemplateRestartSec pins RestartSec=60 (default is 120).
func TestSystemdTemplateRestartSec(t *testing.T) {
	if !strings.Contains(systemdUnit, "RestartSec=60") {
		t.Errorf("systemdUnit missing RestartSec=60")
	}
}

// TestSystemdTemplateStartLimits pins the StartLimitInterval/Burst tuning.
func TestSystemdTemplateStartLimits(t *testing.T) {
	if !strings.Contains(systemdUnit, "StartLimitInterval=300") {
		t.Errorf("systemdUnit missing StartLimitInterval=300")
	}
	if !strings.Contains(systemdUnit, "StartLimitBurst=3") {
		t.Errorf("systemdUnit missing StartLimitBurst=3")
	}
}

// TestSystemdTemplateWantedByDefaultTarget pins the user-target install
// target (default kardianos emits multi-user.target which is wrong for
// a --user unit).
func TestSystemdTemplateWantedByDefaultTarget(t *testing.T) {
	if !strings.Contains(systemdUnit, "WantedBy=default.target") {
		t.Errorf("systemdUnit missing WantedBy=default.target")
	}
	if strings.Contains(systemdUnit, "multi-user.target") {
		t.Errorf("systemdUnit contains multi-user.target — must be default.target for a user unit")
	}
}

// TestSystemdTemplateExecStartServe pins that the unit invokes `serve`.
func TestSystemdTemplateExecStartServe(t *testing.T) {
	if !strings.Contains(systemdUnit, "ExecStart={{.Path|cmdEscape}} serve") {
		t.Errorf("systemdUnit ExecStart does not invoke `serve`")
	}
}

// TestNewReturnsService asserts the factory produces a non-nil
// service.Service without error, exercising the LaunchdConfig/SystemdScript
// wiring at construction time.
func TestNewReturnsService(t *testing.T) {
	svc, err := New("/tmp/jasper-test-data")
	if err != nil {
		t.Fatalf("New(/tmp/jasper-test-data): unexpected err: %v", err)
	}
	if svc == nil {
		t.Fatalf("New returned nil service.Service")
	}
}

// TestNewConfigDeclaresNoEnvVars pins that the installed unit declares no
// environment. It used to carry JASPER_DATA_DIR, which ADR-0008 retired — the
// binary ignores it (see TestRunServe_JasperDataDirEnvIgnored), so the line
// told whoever read the unit to edit a variable nothing consumes. Re-adding an
// env var here means committing to something actually reading it.
func TestNewConfigDeclaresNoEnvVars(t *testing.T) {
	cfg := newConfig("/var/jasper/notes")
	if len(cfg.EnvVars) != 0 {
		t.Errorf("newConfig().EnvVars = %v; want empty — the unit must not declare an env var the binary ignores", cfg.EnvVars)
	}
}

// TestTemplatesEmitNoEnvironmentWhenEnvVarsEmpty guards the rendered end
// product, not just the config: both templates must leave no environment
// block behind when EnvVars is empty.
//
// Rendered against a local struct rather than kardianos's own, which is
// unexported — this exercises our template text, not the library's plumbing.
// cmdEscape is stubbed for the same reason; only the EnvVars blocks matter.
func TestTemplatesEmitNoEnvironmentWhenEnvVarsEmpty(t *testing.T) {
	data := struct {
		Description, Path, Name, LogDirectory string
		StandardOutPath, StandardErrorPath    string
		EnvVars                               map[string]string
	}{
		Description: "Jasper", Path: "/usr/local/bin/jasper", Name: "com.jasper.server",
		LogDirectory: "/home/u/.jasper/logs",
		EnvVars:      newConfig("/home/u/.jasper").EnvVars,
	}
	funcs := template.FuncMap{"cmdEscape": func(s string) string { return s }}

	for name, tmplText := range map[string]string{
		"systemdUnit":  systemdUnit,
		"launchdPlist": launchdPlist,
	} {
		tmpl, err := template.New(name).Funcs(funcs).Parse(tmplText)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		var out strings.Builder
		if err := tmpl.Execute(&out, data); err != nil {
			t.Fatalf("execute %s: %v", name, err)
		}
		for _, marker := range []string{"Environment=", "EnvironmentVariables"} {
			if strings.Contains(out.String(), marker) {
				t.Errorf("%s declares %q with empty EnvVars:\n%s", name, marker, out.String())
			}
		}
	}
}

// TestPlistPathMacOSShape pins the canonical macOS plist path shape.
// On non-darwin OSes the helper still works (it just returns a path
// the OS will never actually use); we assert the suffix either way.
func TestPlistPathMacOSShape(t *testing.T) {
	p, err := PlistPathMacOS()
	if err != nil {
		t.Fatalf("PlistPathMacOS: unexpected err: %v", err)
	}
	want := "/Library/LaunchAgents/com.jasper.server.plist"
	if !strings.HasSuffix(p, want) {
		t.Errorf("PlistPathMacOS = %q; want suffix %q", p, want)
	}
}

// TestBootstrapMacOSNoOpOffDarwin pins that the modern-launchctl helpers
// no-op cleanly off of macOS so cross-platform callers can invoke them
// unconditionally.
func TestBootstrapMacOSNoOpOffDarwin(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("test pins non-darwin no-op behavior; skipping on darwin")
	}
	if err := BootstrapMacOS("/nonexistent/path.plist"); err != nil {
		t.Errorf("BootstrapMacOS off-darwin: want nil, got %v", err)
	}
	if err := BootoutMacOS("/nonexistent/path.plist"); err != nil {
		t.Errorf("BootoutMacOS off-darwin: want nil, got %v", err)
	}
}

// TestEnableLingerLinuxNoOpOffLinux pins that the loginctl helpers
// no-op cleanly off of Linux.
func TestEnableLingerLinuxNoOpOffLinux(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("test pins non-linux no-op behavior; skipping on linux")
	}
	if err := EnableLingerLinux(); err != nil {
		t.Errorf("EnableLingerLinux off-linux: want nil, got %v", err)
	}
	if err := DisableLingerLinux(); err != nil {
		t.Errorf("DisableLingerLinux off-linux: want nil, got %v", err)
	}
}

// TestPlatformHelpersUnitTestOnly documents the test boundary: actually
// invoking launchctl bootstrap or loginctl enable-linger requires a real
// OS + LaunchAgent / systemd context. The unit tests above pin template
// content and no-op behavior on the wrong OS.
func TestPlatformHelpersUnitTestOnly(_ *testing.T) {
}
