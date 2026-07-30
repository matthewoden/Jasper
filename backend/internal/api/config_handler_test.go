package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

func setupConfigServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	t.Setenv("JASPER_APP_HOME", t.TempDir())
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, vault.SubdirName), 0o755); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	srv := NewServerWithIndex(nil, nil, nil, nil, nil, logger, dir)
	si := NewStrictHandler(srv, nil)
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(ConfigStrictBodyMiddleware)
		HandlerFromMux(si, r)
	})
	return httptest.NewServer(r), dir
}

func TestGetConfig_DefaultsOnFirstRun(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/v1/config")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body=%s", resp.StatusCode, body)
	}
	var got Config
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if string(got.Theme) != "dark" {
		t.Errorf("Theme: got %q, want %q", got.Theme, "dark")
	}
	if got.AppName != "Jasper" {
		t.Errorf("AppName: got %q, want %q", got.AppName, "Jasper")
	}
}

func TestPutConfig_RoundTrip(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName": "Jasper",
		"theme": "light",
		"dailyNotes": {"template": ""},
		"editor": {"fontSize": 16, "lineHeight": 1.7, "autosaveMs": 2000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	putBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: got %d, want 200; body: %s", resp.StatusCode, string(putBody))
	}
	var echoed Config
	if err := json.Unmarshal(putBody, &echoed); err != nil {
		t.Fatal(err)
	}
	// The PUT response echoes the submitted config before D-02 load-coercion,
	// so the written value ("light") is reflected here verbatim.
	if string(echoed.Theme) != "light" {
		t.Errorf("Theme: got %q, want %q", echoed.Theme, "light")
	}

	resp2, err := http.Get(ts.URL + "/api/v1/config")
	if err != nil {
		t.Fatal(err)
	}
	getBody, _ := io.ReadAll(resp2.Body)
	_ = resp2.Body.Close()
	var got Config
	if err := json.Unmarshal(getBody, &got); err != nil {
		t.Fatal(err)
	}
	// GET reloads through config.Load, which under D-02 (Phase 17) pins Theme to
	// "dark" regardless of the persisted value — so the effective theme is dark.
	if string(got.Theme) != "dark" {
		t.Errorf("after GET — Theme: got %q, want %q", got.Theme, "dark")
	}
}

func TestPutConfig_UnknownField_400(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName": "Jasper", "theme": "dark", "dailyNotes": {"template": ""},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "autosaveMs": 2000},
		"unknownField": 42
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	unkBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("unknown field: got %d, want 400; body: %s", resp.StatusCode, string(unkBody))
	}
}

func TestPutConfig_ThemeEnum_400(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName": "Jasper", "theme": "neon-purple",
		"dailyNotes": {"template": ""},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "autosaveMs": 2000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("invalid enum: got %d, want 400", resp.StatusCode)
	}
}

// TestPutConfig_DisplayNameField_Rejected400 — D-05: config.Config.DisplayName
// is deleted; the Config schema is additionalProperties:false, so a body
// carrying the legacy "display_name" key is now an unknown field and must be
// rejected with 400, not silently accepted.
func TestPutConfig_DisplayNameField_Rejected400(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName": "Jasper", "theme": "dark",
		"display_name": "My Notes",
		"dailyNotes": {"template": ""},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "autosaveMs": 2000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	putBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("PUT with display_name: got %d, want 400 (unknown field); body: %s", resp.StatusCode, putBody)
	}
}

// TestPutConfig_MissingRequiredSection_Rejected400 — api/openapi.yaml declares
// dailyNotes and editor as `required` on Config. Because PUT replaces the whole
// object, accepting a body that omits one of them writes zero values over the
// user's data. Asserting the persisted template survives is the part that makes
// this non-vacuous: a 400 alone would still pass if the write happened first.
func TestPutConfig_MissingRequiredSection_Rejected400(t *testing.T) {
	seeded := `{"appName":"Jasper","theme":"light","dailyNotes":{"template":"## journal"},"editor":{"fontSize":16,"lineHeight":1.7,"autosaveMs":2000}}`

	for _, tc := range []struct {
		name string
		body string
	}{
		{"omits dailyNotes", `{"appName":"Jasper","theme":"light","editor":{"fontSize":16,"lineHeight":1.7,"autosaveMs":2000}}`},
		{"omits editor", `{"appName":"Jasper","theme":"light","dailyNotes":{"template":"replacement"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ts, _ := setupConfigServer(t)
			defer ts.Close()

			seedReq, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader([]byte(seeded)))
			seedReq.Header.Set("Content-Type", "application/json")
			seedResp, err := http.DefaultClient.Do(seedReq)
			if err != nil {
				t.Fatal(err)
			}
			seedBody, _ := io.ReadAll(seedResp.Body)
			_ = seedResp.Body.Close()
			if seedResp.StatusCode != 200 {
				t.Fatalf("seed PUT: got %d, want 200; body: %s", seedResp.StatusCode, seedBody)
			}

			req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader([]byte(tc.body)))
			req.Header.Set("Content-Type", "application/json")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			putBody, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode != 400 {
				t.Errorf("PUT %s: got %d, want 400; body: %s", tc.name, resp.StatusCode, putBody)
			}

			getResp, err := http.Get(ts.URL + "/api/v1/config")
			if err != nil {
				t.Fatal(err)
			}
			getBody, _ := io.ReadAll(getResp.Body)
			_ = getResp.Body.Close()
			var got Config
			if err := json.Unmarshal(getBody, &got); err != nil {
				t.Fatal(err)
			}
			if got.DailyNotes.Template != "## journal" {
				t.Errorf("after rejected PUT %s — dailyNotes.template: got %q, want %q (a rejected write must not clobber persisted data)", tc.name, got.DailyNotes.Template, "## journal")
			}
			if got.Editor.FontSize != 16 {
				t.Errorf("after rejected PUT %s — editor.fontSize: got %d, want 16", tc.name, got.Editor.FontSize)
			}
		})
	}
}

// TestPutConfig_V14FieldsRoundTrip — PUTs every new D-17 field with
// non-default values and asserts the 200 response echoes them back
// unchanged, and that a subsequent GET /config returns the same values.
// This is the runtime proof that the three-file lockstep (openapi.yaml,
// config.Config, strictConfigValidator) is actually complete.
func TestPutConfig_V14FieldsRoundTrip(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName": "Jasper", "theme": "dark",
		"dailyNotes": {"template": ""},
		"editor": {
			"fontSize": 15, "lineHeight": 1.6, "autosaveMs": 2000,
			"showProperties": false, "autoPair": false, "foldGutter": false,
			"lineNumbers": true, "lineWidth": 900
		},
		"mcp": {"port": 6684, "bind": "127.0.0.1", "auditLog": true},
		"templates": {"folder": "MyTemplates"}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	putBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("PUT status: got %d, want 200; body: %s", resp.StatusCode, putBody)
	}

	assertV14Fields := func(t *testing.T, cfg Config, label string) {
		t.Helper()
		if cfg.Editor.ShowProperties == nil || *cfg.Editor.ShowProperties != false {
			t.Errorf("%s: Editor.ShowProperties = %v, want false", label, cfg.Editor.ShowProperties)
		}
		if cfg.Editor.AutoPair == nil || *cfg.Editor.AutoPair != false {
			t.Errorf("%s: Editor.AutoPair = %v, want false", label, cfg.Editor.AutoPair)
		}
		if cfg.Editor.FoldGutter == nil || *cfg.Editor.FoldGutter != false {
			t.Errorf("%s: Editor.FoldGutter = %v, want false", label, cfg.Editor.FoldGutter)
		}
		if cfg.Editor.LineNumbers == nil || *cfg.Editor.LineNumbers != true {
			t.Errorf("%s: Editor.LineNumbers = %v, want true", label, cfg.Editor.LineNumbers)
		}
		if cfg.Editor.LineWidth == nil || *cfg.Editor.LineWidth != 900 {
			t.Errorf("%s: Editor.LineWidth = %v, want 900", label, cfg.Editor.LineWidth)
		}
		if cfg.Mcp == nil || cfg.Mcp.AuditLog == nil || *cfg.Mcp.AuditLog != true {
			t.Errorf("%s: Mcp.AuditLog = %v, want true", label, cfg.Mcp)
		}
		if cfg.Templates == nil || cfg.Templates.Folder != "MyTemplates" {
			t.Errorf("%s: Templates.Folder = %v, want MyTemplates", label, cfg.Templates)
		}
	}

	var echoed Config
	if err := json.Unmarshal(putBody, &echoed); err != nil {
		t.Fatalf("PUT response unmarshal: %v", err)
	}
	assertV14Fields(t, echoed, "PUT response")

	resp2, err := http.Get(ts.URL + "/api/v1/config")
	if err != nil {
		t.Fatal(err)
	}
	getBody, _ := io.ReadAll(resp2.Body)
	_ = resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("GET status: got %d, want 200; body: %s", resp2.StatusCode, getBody)
	}
	var got Config
	if err := json.Unmarshal(getBody, &got); err != nil {
		t.Fatalf("GET response unmarshal: %v", err)
	}
	assertV14Fields(t, got, "GET after PUT")
}

// TestLineHeightRoundTrip_Precision — toWireConfig / fromWireConfig must
// preserve float64 precision for lineHeight: 1.6 must come back as exactly
// 1.6, not the float32-truncated 1.5999999046325684.
func TestLineHeightRoundTrip_Precision(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName": "Jasper",
		"theme": "dark",
		"dailyNotes": {"template": ""},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "autosaveMs": 2000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	putBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("PUT status: got %d, want 200; body: %s", resp.StatusCode, putBody)
	}

	// GET after PUT — lineHeight must be exactly 1.6 (float64 precision)
	resp2, err := http.Get(ts.URL + "/api/v1/config")
	if err != nil {
		t.Fatal(err)
	}
	getBody, _ := io.ReadAll(resp2.Body)
	_ = resp2.Body.Close()

	// Decode into a generic map to inspect the raw JSON number without struct
	// truncation — this is what the wire actually sends.
	var got Config
	if err := json.Unmarshal(getBody, &got); err != nil {
		t.Fatalf("GET response unmarshal: %v", err)
	}
	const want = 1.6
	if got.Editor.LineHeight != want {
		t.Errorf("lineHeight round-trip precision: got %v, want %v (CR-01 float32 truncation)", got.Editor.LineHeight, want)
	}
}

// TestPutConfig_SyncsAppJSONToDirBasename — D-05: config.Config.DisplayName is
// gone; PUT /config unconditionally syncs the app.json RecentVaults entry's
// display name to filepath.Base(dataDir), regardless of any prior value. The
// vault's name is its folder name — there is no client-supplied override.
//
// Isolation: t.Setenv("JASPER_APP_HOME", t.TempDir()) prevents any writes to
// the real ~/.jasper/app.json (T-17.1-01).
func TestPutConfig_SyncsAppJSONToDirBasename(t *testing.T) {
	// Isolate app.json writes to a test-controlled directory.
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	ts, dataDir := setupConfigServer(t)
	defer ts.Close()

	// Seed app.json with the server's dataDir as the current vault, carrying
	// a stale name that PUT /config must overwrite unconditionally.
	appJSONPath, err := vault.AppJSONPath()
	if err != nil {
		t.Fatalf("AppJSONPath: %v", err)
	}
	initialState := &vault.AppState{
		CurrentVault: dataDir,
		RecentVaults: []vault.RecentVaultEntry{
			{
				Path:        dataDir,
				DisplayName: "OldName",
			},
		},
	}
	if err := vault.SaveAppJSON(appJSONPath, initialState); err != nil {
		t.Fatalf("seed app.json: %v", err)
	}

	body := []byte(`{
		"appName": "Jasper", "theme": "dark",
		"dailyNotes": {"template": ""},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "autosaveMs": 2000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	putBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("PUT /config status: got %d, want 200; body: %s", resp.StatusCode, putBody)
	}

	wantName := filepath.Base(dataDir)
	afterState, err := vault.LoadAppJSON(appJSONPath)
	if err != nil {
		t.Fatalf("load app.json after PUT: %v", err)
	}
	var updatedEntry *vault.RecentVaultEntry
	for i := range afterState.RecentVaults {
		if afterState.RecentVaults[i].Path == dataDir {
			updatedEntry = &afterState.RecentVaults[i]
			break
		}
	}
	if updatedEntry == nil {
		t.Fatalf("RecentVaults entry for %q not found after PUT", dataDir)
	}
	if updatedEntry.DisplayName != wantName {
		t.Errorf("app.json display_name after PUT: got %q, want %q (D-05: vault name is its folder name)", updatedEntry.DisplayName, wantName)
	}

	// GET /vault/current must also reflect the folder-basename name.
	resp2, err := http.Get(ts.URL + "/api/v1/vault/current")
	if err != nil {
		t.Fatal(err)
	}
	getBody, _ := io.ReadAll(resp2.Body)
	_ = resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("GET /vault/current status: got %d, want 200; body: %s", resp2.StatusCode, getBody)
	}

	var vaultResp struct {
		Vault *struct {
			DisplayName string `json:"display_name"`
		} `json:"vault"`
	}
	if err := json.Unmarshal(getBody, &vaultResp); err != nil {
		t.Fatalf("GET /vault/current unmarshal: %v", err)
	}
	if vaultResp.Vault == nil {
		t.Fatal("GET /vault/current returned null vault; expected an entry for the current vault")
	}
	if vaultResp.Vault.DisplayName != wantName {
		t.Errorf("GET /vault/current display_name: got %q, want %q", vaultResp.Vault.DisplayName, wantName)
	}
}

// TestPutConfig_PreservesUnknownFields — a PUT must preserve an unmanaged
// key that was already on disk (merge-on-write).
func TestPutConfig_PreservesUnknownFields(t *testing.T) {
	ts, dir := setupConfigServer(t)
	defer ts.Close()

	configPath := filepath.Join(dir, ".jasper", "config.json")
	seed := []byte(`{
		"appName":"Jasper","theme":"dark",
		"_jasper_unmanaged":"preserve-me",
		"dailyNotes":{"template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":2000},
		"server":{"port":6683,"dataDir":""},
		"mcp":{"enabled":true,"port":6684,"bind":"127.0.0.1"}
	}`)
	if err := os.WriteFile(configPath, seed, 0o644); err != nil {
		t.Fatal(err)
	}

	body := []byte(`{
		"appName": "Jasper", "theme": "light",
		"dailyNotes": {"template": ""},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "autosaveMs": 2000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("PUT status: got %d, want 200; body: %s", resp.StatusCode, respBody)
	}

	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var onDisk map[string]json.RawMessage
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("unmarshal disk: %v", err)
	}
	val, ok := onDisk["_jasper_unmanaged"]
	if !ok {
		t.Error("unmanaged key '_jasper_unmanaged' was dropped by PUT (D-09 regression)")
	} else {
		var s string
		if err := json.Unmarshal(val, &s); err != nil || s != "preserve-me" {
			t.Errorf("unmanaged key value: got %s, want \"preserve-me\"", val)
		}
	}

	theme, ok := onDisk["theme"]
	if !ok {
		t.Error("theme key missing after PUT")
	} else {
		var themeStr string
		if err := json.Unmarshal(theme, &themeStr); err != nil || themeStr != "light" {
			t.Errorf("theme: got %s, want \"light\"", theme)
		}
	}
}

// TestPatchConfig_SparseWriteLeavesOtherFieldsUnchanged — RESEARCH Pitfall
// 2's named warning-sign test: PATCH one nested field and prove every other
// PUT-seeded field survives, rather than merely proving PATCH returns 200.
func TestPatchConfig_SparseWriteLeavesOtherFieldsUnchanged(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	putBody := []byte(`{
		"appName": "Jasper", "theme": "dark",
		"dailyNotes": {"template": "## journal"},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "autosaveMs": 2000}
	}`)
	putReq, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(putBody))
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := http.DefaultClient.Do(putReq)
	if err != nil {
		t.Fatal(err)
	}
	_ = putResp.Body.Close()
	if putResp.StatusCode != 200 {
		t.Fatalf("seed PUT status: got %d, want 200", putResp.StatusCode)
	}

	patchBody := []byte(`{"editor":{"lineHeight":1.5}}`)
	patchReq, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/v1/config", bytes.NewReader(patchBody))
	patchReq.Header.Set("Content-Type", "application/json")
	patchResp, err := http.DefaultClient.Do(patchReq)
	if err != nil {
		t.Fatal(err)
	}
	patchRespBody, _ := io.ReadAll(patchResp.Body)
	_ = patchResp.Body.Close()
	if patchResp.StatusCode != 200 {
		t.Fatalf("PATCH status: got %d, want 200; body: %s", patchResp.StatusCode, patchRespBody)
	}

	resp, err := http.Get(ts.URL + "/api/v1/config")
	if err != nil {
		t.Fatal(err)
	}
	getBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var got Config
	if err := json.Unmarshal(getBody, &got); err != nil {
		t.Fatal(err)
	}

	if got.Editor.LineHeight != 1.5 {
		t.Errorf("editor.lineHeight: got %v, want 1.5 (the patched field)", got.Editor.LineHeight)
	}
	if got.Editor.FontSize != 15 {
		t.Errorf("editor.fontSize: got %v, want 15 (unmentioned by PATCH)", got.Editor.FontSize)
	}
	if got.Editor.AutosaveMs != 2000 {
		t.Errorf("editor.autosaveMs: got %v, want 2000 (unmentioned by PATCH)", got.Editor.AutosaveMs)
	}
	if got.AppName != "Jasper" {
		t.Errorf("appName: got %q, want %q (unmentioned by PATCH)", got.AppName, "Jasper")
	}
	// GET reloads through config.Load, which pins Theme to "dark" (D-02) —
	// consistent with the seed PUT's own value, so this doesn't prove much
	// on its own but documents the field survived the PATCH regardless.
	if string(got.Theme) != "dark" {
		t.Errorf("theme: got %q, want %q (unmentioned by PATCH)", got.Theme, "dark")
	}
	if got.DailyNotes.Template != "## journal" {
		t.Errorf("dailyNotes.template: got %q, want %q (unmentioned by PATCH)", got.DailyNotes.Template, "## journal")
	}
}

// TestPatchConfig_PreservesUnknownFields — mirrors
// TestPutConfig_PreservesUnknownFields: a PATCH must preserve an unmanaged
// top-level key and an unmanaged sub-key inside a managed nested object that
// were already on disk.
func TestPatchConfig_PreservesUnknownFields(t *testing.T) {
	ts, dir := setupConfigServer(t)
	defer ts.Close()

	configPath := filepath.Join(dir, ".jasper", "config.json")
	seed := []byte(`{
		"appName":"Jasper","theme":"dark",
		"_jasper_unmanaged":"preserve-me",
		"dailyNotes":{"template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":2000,"_unmanaged_editor_key":"also-preserve"},
		"server":{"port":6683,"dataDir":""},
		"mcp":{"enabled":true,"port":6684,"bind":"127.0.0.1"}
	}`)
	if err := os.WriteFile(configPath, seed, 0o644); err != nil {
		t.Fatal(err)
	}

	body := []byte(`{"theme":"light"}`)
	req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("PATCH status: got %d, want 200; body: %s", resp.StatusCode, respBody)
	}

	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var onDisk map[string]json.RawMessage
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("unmarshal disk: %v", err)
	}
	val, ok := onDisk["_jasper_unmanaged"]
	if !ok {
		t.Error("unmanaged top-level key '_jasper_unmanaged' was dropped by PATCH")
	} else {
		var s string
		if err := json.Unmarshal(val, &s); err != nil || s != "preserve-me" {
			t.Errorf("unmanaged key value: got %s, want \"preserve-me\"", val)
		}
	}

	var editor map[string]json.RawMessage
	if err := json.Unmarshal(onDisk["editor"], &editor); err != nil {
		t.Fatalf("unmarshal editor: %v", err)
	}
	editorVal, ok := editor["_unmanaged_editor_key"]
	if !ok {
		t.Error("unmanaged nested key 'editor._unmanaged_editor_key' was dropped by PATCH")
	} else {
		var s string
		if err := json.Unmarshal(editorVal, &s); err != nil || s != "also-preserve" {
			t.Errorf("unmanaged nested key value: got %s, want \"also-preserve\"", editorVal)
		}
	}

	theme, ok := onDisk["theme"]
	if !ok {
		t.Error("theme key missing after PATCH")
	} else {
		var themeStr string
		if err := json.Unmarshal(theme, &themeStr); err != nil || themeStr != "light" {
			t.Errorf("theme: got %s, want \"light\"", theme)
		}
	}
}

// TestPatchConfig_ClearsTemplateWithEmptyString — proves an explicit empty
// string is a real write end-to-end, not just past the strict-body
// validator: seed a non-empty dailyNotes.template, PATCH it to "", assert
// the persisted value is "".
func TestPatchConfig_ClearsTemplateWithEmptyString(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	seedBody := []byte(`{
		"appName": "Jasper", "theme": "dark",
		"dailyNotes": {"template": "# {{date}}\n\n"},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "autosaveMs": 2000}
	}`)
	seedReq, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(seedBody))
	seedReq.Header.Set("Content-Type", "application/json")
	seedResp, err := http.DefaultClient.Do(seedReq)
	if err != nil {
		t.Fatal(err)
	}
	_ = seedResp.Body.Close()
	if seedResp.StatusCode != 200 {
		t.Fatalf("seed PUT status: got %d, want 200", seedResp.StatusCode)
	}

	patchBody := []byte(`{"dailyNotes":{"template":""}}`)
	patchReq, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/v1/config", bytes.NewReader(patchBody))
	patchReq.Header.Set("Content-Type", "application/json")
	patchResp, err := http.DefaultClient.Do(patchReq)
	if err != nil {
		t.Fatal(err)
	}
	patchRespBody, _ := io.ReadAll(patchResp.Body)
	_ = patchResp.Body.Close()
	if patchResp.StatusCode != 200 {
		t.Fatalf("PATCH status: got %d, want 200; body: %s", patchResp.StatusCode, patchRespBody)
	}

	resp, err := http.Get(ts.URL + "/api/v1/config")
	if err != nil {
		t.Fatal(err)
	}
	getBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var got Config
	if err := json.Unmarshal(getBody, &got); err != nil {
		t.Fatal(err)
	}
	if got.DailyNotes.Template != "" {
		t.Errorf("dailyNotes.template: got %q, want empty string", got.DailyNotes.Template)
	}
}

// TestPatchConfig_EchoesFullPersistedConfig — the 200 response body is a
// complete Config document (every required key present), not merely the
// patched field, and the patched field carries the new value.
func TestPatchConfig_EchoesFullPersistedConfig(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	seedBody := []byte(`{
		"appName": "Jasper", "theme": "dark",
		"dailyNotes": {"template": ""},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "autosaveMs": 2000}
	}`)
	seedReq, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(seedBody))
	seedReq.Header.Set("Content-Type", "application/json")
	seedResp, err := http.DefaultClient.Do(seedReq)
	if err != nil {
		t.Fatal(err)
	}
	_ = seedResp.Body.Close()
	if seedResp.StatusCode != 200 {
		t.Fatalf("seed PUT status: got %d, want 200", seedResp.StatusCode)
	}

	patchBody := []byte(`{"editor":{"fontSize":22}}`)
	patchReq, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/v1/config", bytes.NewReader(patchBody))
	patchReq.Header.Set("Content-Type", "application/json")
	patchResp, err := http.DefaultClient.Do(patchReq)
	if err != nil {
		t.Fatal(err)
	}
	patchRespBody, _ := io.ReadAll(patchResp.Body)
	_ = patchResp.Body.Close()
	if patchResp.StatusCode != 200 {
		t.Fatalf("PATCH status: got %d, want 200; body: %s", patchResp.StatusCode, patchRespBody)
	}

	var echoed Config
	if err := json.Unmarshal(patchRespBody, &echoed); err != nil {
		t.Fatalf("PATCH response unmarshal: %v", err)
	}
	if echoed.AppName == "" {
		t.Error("PATCH response missing appName — not a full Config document")
	}
	if echoed.Theme == "" {
		t.Error("PATCH response missing theme — not a full Config document")
	}
	if echoed.Editor.AutosaveMs == 0 {
		t.Error("PATCH response missing editor.autosaveMs — not a full Config document")
	}
	if echoed.Editor.FontSize != 22 {
		t.Errorf("editor.fontSize: got %d, want 22 (the patched field)", echoed.Editor.FontSize)
	}
}

// TestPatchConfig_EmptyBodyObject_200 — an empty patch {} is a legal no-op,
// not a 400, and leaves the persisted document semantically unchanged.
func TestPatchConfig_EmptyBodyObject_200(t *testing.T) {
	ts, _ := setupConfigServer(t)
	defer ts.Close()

	seedBody := []byte(`{
		"appName": "Jasper", "theme": "dark",
		"dailyNotes": {"template": "## journal"},
		"editor": {"fontSize": 15, "lineHeight": 1.6, "autosaveMs": 2000}
	}`)
	seedReq, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(seedBody))
	seedReq.Header.Set("Content-Type", "application/json")
	seedResp, err := http.DefaultClient.Do(seedReq)
	if err != nil {
		t.Fatal(err)
	}
	_ = seedResp.Body.Close()
	if seedResp.StatusCode != 200 {
		t.Fatalf("seed PUT status: got %d, want 200", seedResp.StatusCode)
	}

	patchReq, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/v1/config", bytes.NewReader([]byte(`{}`)))
	patchReq.Header.Set("Content-Type", "application/json")
	patchResp, err := http.DefaultClient.Do(patchReq)
	if err != nil {
		t.Fatal(err)
	}
	patchRespBody, _ := io.ReadAll(patchResp.Body)
	_ = patchResp.Body.Close()
	if patchResp.StatusCode != 200 {
		t.Fatalf("empty PATCH status: got %d, want 200; body: %s", patchResp.StatusCode, patchRespBody)
	}

	resp, err := http.Get(ts.URL + "/api/v1/config")
	if err != nil {
		t.Fatal(err)
	}
	getBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var got Config
	if err := json.Unmarshal(getBody, &got); err != nil {
		t.Fatal(err)
	}
	if got.Editor.FontSize != 15 {
		t.Errorf("editor.fontSize: got %d, want 15 (empty patch must be a no-op)", got.Editor.FontSize)
	}
	if got.DailyNotes.Template != "## journal" {
		t.Errorf("dailyNotes.template: got %q, want %q (empty patch must be a no-op)", got.DailyNotes.Template, "## journal")
	}
}

// TestPatchConfig_DoesNotSyncAppJSON — the inverse of
// TestPutConfig_SyncsAppJSONToDirBasename: pins the Task 1 decision that
// PatchConfig performs no app.json write, so a future copy-paste of
// PutConfig's body into PatchConfig fails CI. With JASPER_APP_HOME isolated,
// PATCH one field and assert app.json is byte-identical before and after.
func TestPatchConfig_DoesNotSyncAppJSON(t *testing.T) {
	appHome := t.TempDir()
	t.Setenv("JASPER_APP_HOME", appHome)

	ts, dataDir := setupConfigServer(t)
	defer ts.Close()

	appJSONPath, err := vault.AppJSONPath()
	if err != nil {
		t.Fatalf("AppJSONPath: %v", err)
	}
	initialState := &vault.AppState{
		CurrentVault: dataDir,
		RecentVaults: []vault.RecentVaultEntry{
			{Path: dataDir, DisplayName: "OldName"},
		},
	}
	if err := vault.SaveAppJSON(appJSONPath, initialState); err != nil {
		t.Fatalf("seed app.json: %v", err)
	}
	before, err := os.ReadFile(appJSONPath)
	if err != nil {
		t.Fatalf("read app.json before PATCH: %v", err)
	}

	patchBody := []byte(`{"appName":"Renamed"}`)
	patchReq, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/v1/config", bytes.NewReader(patchBody))
	patchReq.Header.Set("Content-Type", "application/json")
	patchResp, err := http.DefaultClient.Do(patchReq)
	if err != nil {
		t.Fatal(err)
	}
	patchRespBody, _ := io.ReadAll(patchResp.Body)
	_ = patchResp.Body.Close()
	if patchResp.StatusCode != 200 {
		t.Fatalf("PATCH status: got %d, want 200; body: %s", patchResp.StatusCode, patchRespBody)
	}

	after, err := os.ReadFile(appJSONPath)
	if err != nil {
		t.Fatalf("read app.json after PATCH: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Errorf("app.json changed after PATCH /config — PatchConfig must not sync app.json\nbefore: %s\nafter:  %s", before, after)
	}
}
