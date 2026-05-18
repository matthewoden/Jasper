package installer

// systemdUnit overrides the kardianos/service default systemd user-unit
// template.
//
// Why a hand-rolled override exists (D-35):
//
//   - Restart=on-failure (default emits `Restart=always`). The default
//     fights our SIGTERM-as-intentional-shutdown semantics — `jasper
//     uninstall` and `systemctl --user stop jasper` both send SIGTERM,
//     and `always` would respawn the process after both.
//
//   - RestartSec=60 (default is 120). 120s is too long for a user-app
//     where the user is sitting at the wizard waiting for the server
//     to come back up after a config-edit restart.
//
//   - StartLimitInterval=300 + StartLimitBurst=3 (default is 5s/10burst).
//     The default is too tight for migration retries that may legitimately
//     take >5s; the user-facing failure mode is "service flapped 10
//     times and gave up" with no time to investigate.
//
//   - StandardOutput=file:... + StandardError=file:... so PERF-03 is
//     satisfied (log location is predictable, in <dataDir>/logs).
//
//   - WantedBy=default.target (the user-target on systemd user services).
//     The kardianos default emits multi-user.target which is wrong for
//     a `--user` unit.
//
// installer_test.go asserts each line ("Restart=on-failure",
// "RestartSec=60", "StartLimitInterval=300", "WantedBy=default.target")
// is present so a future refactor cannot silently regress to defaults.
//
// Source: RESEARCH.md §"Pattern 1: kardianos/service with custom templates"
// (lines 310-328) — verified against the kardianos master
// service_systemd_linux.go.
const systemdUnit = `[Unit]
Description={{.Description}}
ConditionFileIsExecutable={{.Path|cmdEscape}}

[Service]
ExecStart={{.Path|cmdEscape}} serve
Restart=on-failure
RestartSec=60
StartLimitInterval=300
StartLimitBurst=3
StandardOutput=file:{{.LogDirectory}}/{{.Name}}.out
StandardError=file:{{.LogDirectory}}/{{.Name}}.err
{{range $k, $v := .EnvVars -}}
Environment={{$k}}={{$v}}
{{end -}}

[Install]
WantedBy=default.target
`
