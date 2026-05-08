package config

// DefaultConfig returns the DESIGN.md §11 default values.
//
// Theme defaults to "dark" because the persisted shape needs SOME value;
// the actual first-paint follows prefers-color-scheme via the inline
// bootstrap in frontend/index.html (D-15 — Plan 05-10 wires).
func DefaultConfig() Config {
	return Config{
		AppName: "Jasper",
		DailyNotes: DailyNotes{
			Folder:   "daily",
			Template: "# {{date}}\n\n",
		},
		Editor: Editor{
			FontSize:   15,
			LineHeight: 1.6,
			VimMode:    false,
		},
		Theme: "dark",
	}
}
