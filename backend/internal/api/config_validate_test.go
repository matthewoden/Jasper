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
		"dailyNotes":{"folder":"daily","template":""},
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

// TestConfigMiddleware_DisplayNameField_Rejected400 — D-05: display_name is
// deleted from the Config schema; the strictConfigValidator no longer
// declares it, so any body carrying the legacy key is rejected as an
// unknown field.
func TestConfigMiddleware_DisplayNameField_Rejected400(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName":"Jasper","theme":"dark",
		"display_name":"My Notes",
		"dailyNotes":{"folder":"daily","template":""},
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
		"dailyNotes":{"folder":"daily","template":""},
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
// D-17 field (templates.folder, editor.{showProperties,autoPair,foldGutter,
// lineNumbers,lineWidth}, mcp.auditLog) alongside the existing required
// fields must pass the strict-body middleware (no 400).
func TestConfigStrictBody_AcceptsAllV14Fields(t *testing.T) {
	ts := setupValidateServer(t)
	defer ts.Close()

	body := []byte(`{
		"appName":"Jasper","theme":"dark",
		"dailyNotes":{"folder":"daily","template":""},
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
		"dailyNotes":{"folder":"daily","template":""},
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

// TestStrictConfigValidatorMatchesConfigStruct is the D-16 safety net: it
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
