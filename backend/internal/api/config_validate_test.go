package api

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

func setupValidateServer(t *testing.T) *httptest.Server {
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
	return httptest.NewServer(r)
}

// validConfigBody returns a minimal valid PUT /config body for testing.
// autosaveMs is injected as the specified value.
func validConfigBodyWithAutosave(autosaveMs int) []byte {
	body := []byte(`{
		"appName":"Jasper","theme":"dark",
		"dailyNotes":{"template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":` +
		itoa(autosaveMs) + `}
	}`)
	return body
}

// itoa avoids importing "strconv" at the package level.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	pos := len(buf)
	for n > 0 {
		pos--
		buf[pos] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

// TestConfigMiddleware_AutosaveMs — autosaveMs range validation:
// 249 → 400, 250 → 200, 10000 → 200, 10001 → 400.
func TestConfigMiddleware_AutosaveMs(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	tests := []struct {
		autosaveMs int
		wantStatus int
	}{
		{249, 400},
		{250, 200},
		{10000, 200},
		{10001, 400},
	}

	for _, tc := range tests {
		body := validConfigBodyWithAutosave(tc.autosaveMs)
		req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("autosaveMs=%d: request error: %v", tc.autosaveMs, err)
		}
		respBody, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != tc.wantStatus {
			t.Errorf("autosaveMs=%d: got %d, want %d; body=%s",
				tc.autosaveMs, resp.StatusCode, tc.wantStatus, respBody)
		}
	}
}

// TestConfigMiddleware_DisplayNameField_Rejected400: display_name is
// deleted from the Config schema; the strictConfigValidator no longer
// declares it, so any body carrying the legacy key is rejected as an
// unknown field.
func TestConfigMiddleware_DisplayNameField_Rejected400(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName":"Jasper","theme":"dark",
		"display_name":"My Notes",
		"dailyNotes":{"template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":2000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("display_name field: got %d, want 400 (unknown field); body=%s", resp.StatusCode, respBody)
	}
}

// TestConfigMiddleware_ServerBindAccepted — a body carrying server.bind must NOT
// be rejected as an unknown field. The Settings panel round-trips the full
// config including server.bind, so the strict validator must recognize it.
func TestConfigMiddleware_ServerBindAccepted(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName":"Jasper","theme":"dark",
		"dailyNotes":{"template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":2000},
		"server":{"port":6683,"dataDir":"/tmp/x","bind":"0.0.0.0"}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode == 400 {
		t.Errorf("server.bind rejected as unknown field: got 400; body=%s", respBody)
	}
}

// TestConfigStrictBody_AcceptsAllV14Fields — a PUT body carrying every new
// newer field (templates.folder, editor.{showProperties,autoPair,foldGutter,
// lineNumbers,lineWidth}, mcp.auditLog) alongside the existing required
// fields must pass the strict-body middleware (no 400).
func TestConfigStrictBody_AcceptsAllV14Fields(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName":"Jasper","theme":"dark",
		"dailyNotes":{"template":""},
		"editor":{
			"fontSize":15,"lineHeight":1.6,"autosaveMs":2000,
			"showProperties":false,"autoPair":false,"foldGutter":false,
			"lineNumbers":true,"lineWidth":900
		},
		"mcp":{"port":6684,"bind":"127.0.0.1","auditLog":true},
		"templates":{"folder":"MyTemplates"}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode == 400 {
		t.Errorf("v1.4 fields rejected: got 400; body=%s", respBody)
	}
}

// TestConfigStrictBody_RejectsLineWidthOutOfRange — editor.lineWidth outside
// the 400-2000 range must be rejected with 400 invalid_request.
func TestConfigStrictBody_RejectsLineWidthOutOfRange(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName":"Jasper","theme":"dark",
		"dailyNotes":{"template":""},
		"editor":{"fontSize":15,"lineHeight":1.6,"autosaveMs":2000,"lineWidth":3000}
	}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("lineWidth=3000: got %d, want 400; body=%s", resp.StatusCode, respBody)
	}
	if !bytes.Contains(respBody, []byte(`"invalid_request"`)) {
		t.Errorf("lineWidth=3000: body missing invalid_request code; body=%s", respBody)
	}
}

// TestConfigMiddleware_Patch_UnknownField_400 — an unknown top-level key on
// PATCH is rejected exactly like PUT.
func TestConfigMiddleware_Patch_UnknownField_400(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{"unknownField":42}`)
	req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("unknown field: got %d, want 400; body=%s", resp.StatusCode, respBody)
	}
}

// TestConfigMiddleware_Patch_FontSizeOutOfRange_400 — editor.fontSize outside
// 8-32 is rejected with the same message text PUT uses.
func TestConfigMiddleware_Patch_FontSizeOutOfRange_400(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{"editor":{"fontSize":999}}`)
	req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("fontSize=999: got %d, want 400; body=%s", resp.StatusCode, respBody)
	}
	if !bytes.Contains(respBody, []byte("editor.fontSize must be 8–32")) {
		t.Errorf("fontSize=999: body missing expected message; body=%s", respBody)
	}
}

// TestConfigMiddleware_Patch_ThemeEnum_400 — an invalid theme value on PATCH
// is rejected exactly like PUT.
func TestConfigMiddleware_Patch_ThemeEnum_400(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{"theme":"solarized"}`)
	req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("theme=solarized: got %d, want 400; body=%s", resp.StatusCode, respBody)
	}
}

// TestConfigMiddleware_Patch_OmittedRequiredFields_200 — a PATCH body that
// omits fields required on PUT (appName, theme, dailyNotes, etc.) passes the
// middleware. This is the test that fails loudly if strictConfigPatchValidator
// were built by reusing the value-typed strictConfigValidator (an omitted
// fontSize would read as 0 and 400 as out-of-range).
func TestConfigMiddleware_Patch_OmittedRequiredFields_200(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{"editor":{"lineHeight":1.5}}`)
	req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("sparse patch with omitted required fields: got %d, want 200; body=%s", resp.StatusCode, respBody)
	}
}

// TestConfigMiddleware_Patch_EmptyTemplateAccepted — an explicit empty
// string for dailyNotes.template is a legitimate write (clearing the
// template), not rejected as "empty means omitted."
func TestConfigMiddleware_Patch_EmptyTemplateAccepted(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{"dailyNotes":{"template":""}}`)
	req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("empty template: got %d, want 200; body=%s", resp.StatusCode, respBody)
	}
}

// TestConfigMiddleware_Patch_UnknownNestedField_400 — DisallowUnknownFields
// reaches nested objects on the PATCH path too.
func TestConfigMiddleware_Patch_UnknownNestedField_400(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{"editor":{"nope":1}}`)
	req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/v1/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("unknown nested field: got %d, want 400; body=%s", resp.StatusCode, respBody)
	}
}

// collectJSONPaths walks t (a struct type, following pointer indirection at
// every level) and returns the set of dotted json-tag paths for every leaf
// field, recursing into nested struct-typed fields regardless of whether
// they are named types or anonymous inline structs.
func collectJSONPaths(t reflect.Type, prefix string) map[string]bool {
	paths := map[string]bool{}
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return paths
	}
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := f.Tag.Get("json")
		if tag == "" || tag == "-" {
			continue
		}
		name := strings.Split(tag, ",")[0]
		if name == "" {
			continue
		}
		fieldPath := name
		if prefix != "" {
			fieldPath = prefix + "." + name
		}
		ft := f.Type
		for ft.Kind() == reflect.Pointer {
			ft = ft.Elem()
		}
		if ft.Kind() == reflect.Struct {
			for k := range collectJSONPaths(ft, fieldPath) {
				paths[k] = true
			}
			continue
		}
		paths[fieldPath] = true
	}
	return paths
}

// TestStrictConfigValidatorMatchesConfigStruct is the safety net: it
// converts a drift between config.Config and strictConfigValidator from
// "400s at runtime on the user's first save of a new field" into "fails in
// CI the moment the second file is edited without the third". The three-file
// lockstep this phase relies on is api/openapi.yaml -> config.Config ->
// strictConfigValidator; this test cannot see api/openapi.yaml (the third
// file) — it only proves the two Go-side structs agree with each other.
func TestStrictConfigValidatorMatchesConfigStruct(t *testing.T) {
	t.Parallel()
	cfgPaths := collectJSONPaths(reflect.TypeOf(config.Config{}), "")
	validatorPaths := collectJSONPaths(reflect.TypeOf(strictConfigValidator{}), "")

	var missingFromValidator, missingFromConfig []string
	for p := range cfgPaths {
		if !validatorPaths[p] {
			missingFromValidator = append(missingFromValidator, p)
		}
	}
	for p := range validatorPaths {
		if !cfgPaths[p] {
			missingFromConfig = append(missingFromConfig, p)
		}
	}
	sort.Strings(missingFromValidator)
	sort.Strings(missingFromConfig)

	if len(missingFromValidator) == 0 && len(missingFromConfig) == 0 {
		return
	}
	var b strings.Builder
	for _, p := range missingFromValidator {
		b.WriteString(p + " present in config.Config but missing from strictConfigValidator\n")
	}
	for _, p := range missingFromConfig {
		b.WriteString(p + " present in strictConfigValidator but missing from config.Config\n")
	}
	t.Errorf("config.Config and strictConfigValidator have drifted:\n%s", b.String())
}

// ConfigPatch cannot $ref Config and subtract `required` — OpenAPI 3.1 has no
// such operator — so a hand-maintained twin schema is unavoidable. This pins
// 1:1 parity across all three definitions, turning a field added to Config but
// forgotten in ConfigPatch from a silent runtime 400 into a CI failure.
func TestStrictConfigPatchValidatorMatchesConfigStruct(t *testing.T) {
	t.Parallel()
	cfgPaths := collectJSONPaths(reflect.TypeOf(config.Config{}), "")
	validatorPaths := collectJSONPaths(reflect.TypeOf(strictConfigPatchValidator{}), "")
	genPaths := collectJSONPaths(reflect.TypeOf(ConfigPatch{}), "")

	report := func(a, b map[string]bool, aName, bName string) []string {
		var missing []string
		for p := range a {
			if !b[p] {
				missing = append(missing, p+" present in "+aName+" but missing from "+bName)
			}
		}
		return missing
	}

	var problems []string
	problems = append(problems, report(cfgPaths, validatorPaths, "config.Config", "strictConfigPatchValidator")...)
	problems = append(problems, report(validatorPaths, cfgPaths, "strictConfigPatchValidator", "config.Config")...)
	problems = append(problems, report(cfgPaths, genPaths, "config.Config", "generated ConfigPatch")...)
	problems = append(problems, report(genPaths, cfgPaths, "generated ConfigPatch", "config.Config")...)
	problems = append(problems, report(validatorPaths, genPaths, "strictConfigPatchValidator", "generated ConfigPatch")...)
	problems = append(problems, report(genPaths, validatorPaths, "generated ConfigPatch", "strictConfigPatchValidator")...)

	if len(problems) == 0 {
		return
	}
	sort.Strings(problems)
	var b strings.Builder
	for _, p := range problems {
		b.WriteString(p + "\n")
	}
	t.Errorf("config.Config, strictConfigPatchValidator, and generated ConfigPatch have drifted:\n%s", b.String())
}
