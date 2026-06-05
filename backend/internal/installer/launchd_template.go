package installer

const launchdPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{{html .Name}}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{html .Path}}</string>
        <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>Crashed</key>
        <true/>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>60</integer>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>{{html .StandardOutPath}}</string>
    <key>StandardErrorPath</key>
    <string>{{html .StandardErrorPath}}</string>
    {{- if .EnvVars}}
    <key>EnvironmentVariables</key>
    <dict>
        {{- range $k, $v := .EnvVars}}
        <key>{{html $k}}</key>
        <string>{{html $v}}</string>
        {{- end}}
    </dict>
    {{- end}}
</dict>
</plist>
`
