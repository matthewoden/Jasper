package installer

// launchdPlist overrides the kardianos/service default launchd template.
//
// Why a hand-rolled override exists (D-35 + ROADMAP success criterion #1):
//
//   - The kardianos default emits `<key>KeepAlive</key><true/>` (BOOL form).
//     That tells launchd "restart on EVERY exit", including the graceful
//     `launchctl bootout` that `jasper uninstall` issues — which means an
//     uninstall would be silently re-spawned. The dict form below restricts
//     restarts to crashes (Crashed=true) and explicitly excludes successful
//     exits (SuccessfulExit=false).
//
//   - The kardianos default omits ThrottleInterval entirely. launchd's
//     undocumented default is 10s — too tight for a fail-fast migration
//     loop. We pin 60s.
//
//   - ProcessType=Interactive is the LaunchAgent best practice on
//     macOS 10.10+ (lets the agent receive UI-event-class signals).
//
//   - StandardOutPath + StandardErrorPath point at <dataDir>/logs/<Label>.log
//     so PERF-03 (log location is predictable + rotated by the app) is
//     satisfied. The {{.StandardOutPath}} / {{.StandardErrorPath}} fields
//     are populated by kardianos/service from Option["LogDirectory"] +
//     Name.
//
// ROADMAP success criterion #1 demands the verbatim strings
// `KeepAlive: {Crashed: true}` + `ThrottleInterval=60`. installer_test.go
// asserts the template contains both so this override can never silently
// regress back to defaults.
//
// Source: RESEARCH.md §"Pattern 1: kardianos/service with custom templates"
// (lines 257-296) — empirically verified against the kardianos master
// service_darwin.go on 2026-05-17.
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
