package vault

import "github.com/matthewoden/jasper/backend/internal/config"

// CLIResolution is everything `jasper doctor` and `jasper status` need before
// they can report anything: where app.json lives, what it said, and which vault
// directory the command should inspect.
//
// Errors are carried rather than returned because both commands are
// diagnostics — an unreadable app.json is a finding to print, not a reason to
// exit. Callers decide which failures matter to them.
type CLIResolution struct {
	AppJSONPath string
	AppJSONErr  error
	AppHomePath string
	AppHomeErr  error

	// State is nil when app.json is absent or unreadable.
	State *AppState

	// DataDir is the vault to inspect. Never empty — falls back to the
	// default data dir so a command still has something to report on.
	DataDir string

	// Overridden reports that DataDir came from --vault rather than app.json.
	Overridden bool
}

// ResolveForCLI applies the --vault → app.json → default precedence chain.
//
// vaultFlag is used even when it fails to canonicalize: a path the user typed
// that does not resolve is exactly what a diagnostic should report on, and
// silently falling back to a different vault would have doctor check something
// the user never asked about.
func ResolveForCLI(vaultFlag string) CLIResolution {
	res := CLIResolution{}

	res.AppJSONPath, res.AppJSONErr = AppJSONPath()
	res.AppHomePath, res.AppHomeErr = AppHomePath()

	if res.AppJSONErr == nil {
		if state, err := LoadAppJSON(res.AppJSONPath); err == nil {
			res.State = state
		}
	}

	switch {
	case vaultFlag != "":
		res.Overridden = true
		if c, err := Canonicalize(vaultFlag); err == nil {
			res.DataDir = c
		} else {
			res.DataDir = vaultFlag
		}
	case res.State != nil && res.State.CurrentVault != "":
		res.DataDir = res.State.CurrentVault
	default:
		res.DataDir = config.DefaultDataDir()
	}

	return res
}
