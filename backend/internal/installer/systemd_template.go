package installer

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
