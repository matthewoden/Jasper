package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

var jasperBin string

// TestMain builds the binary once for the whole package run.
func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "jasper-smoke-bin-*")
	if err != nil {
		fmt.Fprintln(os.Stderr, "smoke: mktempdir:", err)
		os.Exit(2)
	}
	defer func() { _ = os.RemoveAll(tmp) }()
	jasperBin = filepath.Join(tmp, "jasper")
	cmd := exec.Command("go", "build", "-o", jasperBin, ".")
	cmd.Stderr = os.Stderr
	cmd.Stdout = os.Stdout
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "smoke: build:", err)
		os.Exit(2)
	}
	os.Exit(m.Run())
}

func pickFreePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	addr := l.Addr().String()
	if err := l.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return addr
}

// syncBuffer guards the capture buffer. Handing exec.Cmd a writer that is not an
// *os.File makes it copy the child's output on its own goroutine, and these tests
// read the log while the child is still running — an unsynchronised bytes.Buffer
// there is a data race that only -race reports.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func spawn(t *testing.T, dataDir, addr string, env []string) (*exec.Cmd, *syncBuffer) {
	t.Helper()
	cmd := exec.Command(jasperBin, "serve", "--vault", dataDir, "--bind", addr)
	cmd.Env = append(os.Environ(), env...)
	buf := &syncBuffer{}
	cmd.Stdout = buf
	cmd.Stderr = buf
	if err := cmd.Start(); err != nil {
		t.Fatalf("spawn: %v", err)
	}
	return cmd, buf
}

func killAndWait(t *testing.T, cmd *exec.Cmd, log *syncBuffer) {
	t.Helper()
	if cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:

	case <-time.After(6 * time.Second):
		_ = cmd.Process.Kill()
		<-done
		if log != nil {
			t.Logf("smoke binary did not exit within 6s; output:\n%s", log.String())
		}
	}
}

func waitForListener(t *testing.T, addr string, timeout time.Duration) error {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err == nil {
			_ = c.Close()
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return errors.New("waitForListener: timed out")
}

func httpGet(t *testing.T, url string) (int, []byte) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp.StatusCode, body
}

// originFor returns the scheme://host origin of a request URL (browser-like Origin header).
func originFor(t *testing.T, rawURL string) string {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse url %q: %v", rawURL, err)
	}
	return u.Scheme + "://" + u.Host
}

func httpPut(t *testing.T, url string, body []byte) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", originFor(t, url))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT %s: %v", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp.StatusCode, respBody
}

func httpPost(t *testing.T, url string, body []byte) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", originFor(t, url))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp.StatusCode, respBody
}

func copyFile(t *testing.T, src, dst string) {
	t.Helper()
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("read %s: %v", src, err)
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		t.Fatalf("write %s: %v", dst, err)
	}
}

func TestSmoke_HappyPath_FreshDB(t *testing.T) {
	dataDir := t.TempDir()
	addr := pickFreePort(t)
	cmd, log := spawn(t, dataDir, addr, nil)
	defer killAndWait(t, cmd, log)

	if err := waitForListener(t, addr, 10*time.Second); err != nil {
		t.Fatalf("listener never came up; output:\n%s", log.String())
	}

	base := "http://" + addr

	status, body := httpGet(t, base+"/api/v1/notes")
	if status != 200 {
		t.Fatalf("GET /api/v1/notes status: got %d; body=%s", status, body)
	}
	var listOut struct {
		Notes []struct {
			ID   string `json:"id"`
			Path string `json:"path"`
		} `json:"notes"`
	}
	if err := json.Unmarshal(body, &listOut); err != nil {
		t.Fatalf("unmarshal notes: %v; body=%s", err, body)
	}
	foundScratchpad := false
	for _, n := range listOut.Notes {
		if n.Path == notes.ScratchpadRelPath {
			foundScratchpad = true
			if n.ID != notes.ScratchpadUUID.String() {
				t.Errorf("scratchpad id: got %q, want %q", n.ID, notes.ScratchpadUUID.String())
			}
		}
	}
	if !foundScratchpad {
		t.Fatalf("scratchpad.md not in /api/v1/notes; body=%s", body)
	}

	status, body = httpGet(t, base+"/api/v1/notes/"+notes.ScratchpadUUID.String())
	if status != 200 {
		t.Fatalf("GET scratchpad-by-UUID status: got %d; body=%s", status, body)
	}
	if !bytes.Contains(body, []byte("Welcome to Jasper")) {
		t.Errorf("scratchpad body did not contain welcome marker: %s", body)
	}

	status, body = httpGet(t, base+"/api/v1/admin/status")
	if status != 200 {
		t.Fatalf("GET /admin/status status: got %d; body=%s", status, body)
	}
	var statusOut struct {
		State    string `json:"state"`
		LogsPath string `json:"logs_path"`
	}
	if err := json.Unmarshal(body, &statusOut); err != nil {
		t.Fatalf("unmarshal status: %v; body=%s", err, body)
	}
	if statusOut.State != "ok" {
		t.Errorf("admin/status state: got %q, want ok", statusOut.State)
	}

	putBody, _ := json.Marshal(map[string]string{"content": "# smoke round-trip"})
	status, body = httpPut(t, base+"/api/v1/notes/"+notes.ScratchpadUUID.String(), putBody)
	if status != 200 {
		t.Fatalf("PUT scratchpad status: got %d; body=%s", status, body)
	}

	status, body = httpGet(t, base+"/api/v1/notes/"+notes.ScratchpadUUID.String())
	if status != 200 {
		t.Fatalf("re-GET scratchpad status: got %d; body=%s", status, body)
	}
	if !bytes.Contains(body, []byte("# smoke round-trip")) {
		t.Errorf("scratchpad body did not reflect update: %s", body)
	}
}

func TestSmoke_BrokenMigration_FiresPath1_Banner(t *testing.T) {
	dataDir := t.TempDir()
	addr := pickFreePort(t)

	overrideDir := t.TempDir()
	// Baseline mirrors the full shipped migration set (through 006_birthtime)
	// so the post-rollback schema matches a real deployment's
	// last-known-good state — GET /api/v1/notes reads birthtime_unix.
	copyFile(t, "../../migrations/001_initial.sql", filepath.Join(overrideDir, "001_initial.sql"))
	copyFile(t, "../../migrations/002_tags_backlinks.sql", filepath.Join(overrideDir, "002_tags_backlinks.sql"))
	copyFile(t, "../../migrations/003_fts.sql", filepath.Join(overrideDir, "003_fts.sql"))
	copyFile(t, "../../migrations/004_mcp_grants.sql", filepath.Join(overrideDir, "004_mcp_grants.sql"))
	copyFile(t, "../../migrations/005_backlink_multi_excerpt.sql", filepath.Join(overrideDir, "005_backlink_multi_excerpt.sql"))
	copyFile(t, "../../migrations/006_birthtime.sql", filepath.Join(overrideDir, "006_birthtime.sql"))

	env1 := []string{"JASPER_TEST_MIGRATIONS_DIR=" + overrideDir}
	cmd, log := spawn(t, dataDir, addr, env1)

	if err := waitForListener(t, addr, 10*time.Second); err != nil {
		killAndWait(t, cmd, log)
		t.Fatalf("first listener never came up; output:\n%s", log.String())
	}

	status, body := httpGet(t, "http://"+addr+"/api/v1/admin/status")
	if status != 200 {
		killAndWait(t, cmd, log)
		t.Fatalf("first /admin/status status: got %d; body=%s", status, body)
	}
	killAndWait(t, cmd, log)

	if err := os.WriteFile(filepath.Join(overrideDir, "007_break.sql"),
		[]byte("THIS IS NOT VALID SQL;"), 0o644); err != nil {
		t.Fatalf("write 007_break.sql: %v", err)
	}

	addr2 := pickFreePort(t)
	cmd2, log2 := spawn(t, dataDir, addr2, env1)
	defer killAndWait(t, cmd2, log2)

	if err := waitForListener(t, addr2, 10*time.Second); err != nil {
		t.Fatalf("second listener never came up; output:\n%s", log2.String())
	}

	status, body = httpGet(t, "http://"+addr2+"/api/v1/admin/status")
	if status != 200 {
		t.Fatalf("second /admin/status status: got %d; body=%s", status, body)
	}
	var st struct {
		State           string `json:"state"`
		FailedMigration string `json:"failed_migration"`
		LogsPath        string `json:"logs_path"`
	}
	if err := json.Unmarshal(body, &st); err != nil {
		t.Fatalf("unmarshal admin/status: %v; body=%s", err, body)
	}
	if st.State != "rolled_back" {
		t.Errorf("state: got %q, want rolled_back; body=%s", st.State, body)
	}
	if st.FailedMigration != "007_break.sql" {
		t.Errorf("failed_migration: got %q, want 007_break.sql", st.FailedMigration)
	}
	if st.LogsPath == "" {
		t.Errorf("logs_path empty; want a path under data dir")
	}

	status, body = httpGet(t, "http://"+addr2+"/api/v1/notes")
	if status != 200 {
		t.Errorf("GET /api/v1/notes after rollback: got %d; body=%s", status, body)
	}
}

func TestSmoke_DiskFull_ServesStaticPage(t *testing.T) {
	dataDir := t.TempDir()
	addr := pickFreePort(t)

	cmd, log := spawn(t, dataDir, addr, nil)
	if err := waitForListener(t, addr, 10*time.Second); err != nil {
		killAndWait(t, cmd, log)
		t.Fatalf("seed listener never came up; output:\n%s", log.String())
	}
	killAndWait(t, cmd, log)

	addr2 := pickFreePort(t)
	cmd2, log2 := spawn(t, dataDir, addr2, []string{"JASPER_TEST_FORCE_DISK_FULL=1"})
	defer killAndWait(t, cmd2, log2)

	if err := waitForListener(t, addr2, 10*time.Second); err != nil {
		t.Fatalf("disk-full listener never came up; output:\n%s", log2.String())
	}

	status, body := httpGet(t, "http://"+addr2+"/")
	if status != http.StatusServiceUnavailable {
		t.Errorf("GET / status: got %d, want 503; body=%s", status, body)
	}
	if !bytes.Contains(body, []byte("Not enough disk space to start.")) {
		t.Errorf("body missing locked headline; got:\n%s", body)
	}

	status, body = httpGet(t, "http://"+addr2+"/api/v1/notes")
	if status != http.StatusServiceUnavailable {
		t.Errorf("GET /api/v1/notes status: got %d, want 503; body=%s", status, body)
	}
	if !bytes.Contains(body, []byte(`"code":"unrecoverable"`)) {
		t.Errorf("API body missing code=unrecoverable; got: %s", body)
	}
}

func TestSmoke_ConcurrentSaves_NoSQLITE_BUSY(t *testing.T) {
	dataDir := t.TempDir()
	addr := pickFreePort(t)
	cmd, log := spawn(t, dataDir, addr, nil)
	defer killAndWait(t, cmd, log)

	if err := waitForListener(t, addr, 10*time.Second); err != nil {
		t.Fatalf("listener never came up; output:\n%s", log.String())
	}

	url := "http://" + addr + "/api/v1/notes/" + notes.ScratchpadUUID.String()
	origin := "http://" + addr
	const N = 100

	var wg sync.WaitGroup
	failures := make(chan error, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body, _ := json.Marshal(map[string]string{
				"content": fmt.Sprintf("# concurrent write %d", i),
			})
			req, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(body))
			if err != nil {
				failures <- fmt.Errorf("req %d: %w", i, err)
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", origin)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				failures <- fmt.Errorf("do %d: %w", i, err)
				return
			}
			respBody, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode != 200 {
				failures <- fmt.Errorf("req %d: status %d body=%s", i, resp.StatusCode, respBody)
				return
			}
			lower := strings.ToLower(string(respBody))
			if strings.Contains(lower, "sqlite_busy") || strings.Contains(lower, "database is locked") {
				failures <- fmt.Errorf("req %d body contained busy/locked: %s", i, respBody)
			}
		}(i)
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Errorf("concurrent save failure: %v", err)
	}
}

func TestSmoke_HTTPListenerGatedByMigration(t *testing.T) {
	dataDir := t.TempDir()
	addr := pickFreePort(t)
	cmd, log := spawn(t, dataDir, addr, nil)
	defer killAndWait(t, cmd, log)

	url := "http://" + addr + "/api/v1/admin/status"
	deadline := time.Now().Add(10 * time.Second)
	sawSuccess := false
	preSuccessRefusals := 0
	for time.Now().Before(deadline) {
		resp, err := http.Get(url)
		if err != nil {
			if isConnRefused(err) {
				preSuccessRefusals++
			} else {
				preSuccessRefusals++
			}
			time.Sleep(10 * time.Millisecond)
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode == 200 && bytes.Contains(body, []byte("\"state\"")) {
			sawSuccess = true
			break
		}

		t.Errorf(
			"listener accepted before migrations finished: status=%d body=%s",
			resp.StatusCode, body,
		)
		break
	}
	if !sawSuccess {
		t.Errorf("never saw a successful /admin/status response in 10s; refusals=%d output:\n%s",
			preSuccessRefusals, log.String())
	}
}

func isConnRefused(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "connection refused") || strings.Contains(s, "ECONNREFUSED")
}

func TestSmoke_ResetAndRebuild_FullPath2Flow(t *testing.T) {
	dataDir := t.TempDir()

	overrideDir := t.TempDir()
	copyFile(t, "../../migrations/001_initial.sql", filepath.Join(overrideDir, "001_initial.sql"))
	copyFile(t, "../../migrations/002_tags_backlinks.sql", filepath.Join(overrideDir, "002_tags_backlinks.sql"))
	copyFile(t, "../../migrations/003_fts.sql", filepath.Join(overrideDir, "003_fts.sql"))
	copyFile(t, "../../migrations/006_birthtime.sql", filepath.Join(overrideDir, "006_birthtime.sql"))
	addr := pickFreePort(t)
	cmd, log := spawn(t, dataDir, addr, []string{"JASPER_TEST_MIGRATIONS_DIR=" + overrideDir})
	if err := waitForListener(t, addr, 10*time.Second); err != nil {
		killAndWait(t, cmd, log)
		t.Fatalf("first listener never came up; output:\n%s", log.String())
	}
	killAndWait(t, cmd, log)

	if err := os.WriteFile(filepath.Join(overrideDir, "004_break.sql"),
		[]byte("THIS IS NOT VALID SQL;"), 0o644); err != nil {
		t.Fatalf("write 004_break.sql: %v", err)
	}
	addr2 := pickFreePort(t)
	cmd2, log2 := spawn(t, dataDir, addr2, []string{"JASPER_TEST_MIGRATIONS_DIR=" + overrideDir})
	defer killAndWait(t, cmd2, log2)
	if err := waitForListener(t, addr2, 10*time.Second); err != nil {
		t.Fatalf("second listener never came up; output:\n%s", log2.String())
	}

	_, body := httpGet(t, "http://"+addr2+"/api/v1/admin/status")
	var st struct {
		State           string `json:"state"`
		FailedMigration string `json:"failed_migration"`
	}
	if err := json.Unmarshal(body, &st); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if st.State != "rolled_back" {
		t.Fatalf("expected rolled_back before reset, got %q; body=%s", st.State, body)
	}

	if err := os.Remove(filepath.Join(overrideDir, "004_break.sql")); err != nil {
		t.Fatalf("remove 004_break.sql: %v", err)
	}

	postBody, _ := json.Marshal(map[string]string{"mode": "full"})
	status, body := httpPost(t, "http://"+addr2+"/api/v1/admin/reindex", postBody)
	if status != 202 {
		t.Fatalf("POST /admin/reindex status: got %d, want 202; body=%s", status, body)
	}

	_, body = httpGet(t, "http://"+addr2+"/api/v1/admin/status")
	if err := json.Unmarshal(body, &st); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}
	if st.State != "ok" {
		t.Errorf("after reset: state got %q, want ok; body=%s", st.State, body)
	}

	status, body = httpGet(t, "http://"+addr2+"/api/v1/notes")
	if status != 200 {
		t.Errorf("after reset: GET /notes status got %d; body=%s", status, body)
	}
}

func TestSmoke_CaseCollisionRejection(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("APFS case-insensitive by default; collision happens at OS layer, not indexer")
	}

	dataDir := t.TempDir()
	notesDir := filepath.Join(dataDir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}
	if err := os.WriteFile(filepath.Join(notesDir, "Foo.md"), []byte("# Foo"), 0o644); err != nil {
		t.Fatalf("write Foo.md: %v", err)
	}
	if err := os.WriteFile(filepath.Join(notesDir, "foo.md"), []byte("# foo"), 0o644); err != nil {
		t.Fatalf("write foo.md: %v", err)
	}

	addr := pickFreePort(t)
	cmd, log := spawn(t, dataDir, addr, nil)
	defer killAndWait(t, cmd, log)

	if err := waitForListener(t, addr, 10*time.Second); err != nil {
		t.Fatalf("listener never came up; output:\n%s", log.String())
	}

	time.Sleep(500 * time.Millisecond)

	status, body := httpGet(t, "http://"+addr+"/api/v1/notes")
	if status != 200 {
		t.Fatalf("GET /api/v1/notes status: got %d; body=%s", status, body)
	}
	var listOut struct {
		Notes []struct {
			Path string `json:"path"`
		} `json:"notes"`
	}
	if err := json.Unmarshal(body, &listOut); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, body)
	}

	fooCount := 0
	for _, n := range listOut.Notes {
		if strings.EqualFold(n.Path, "foo.md") {
			fooCount++
		}
	}
	if fooCount != 1 {
		t.Errorf("foo* entry count: got %d, want 1 (collision should drop the duplicate); list=%v", fooCount, listOut.Notes)
	}

	if !strings.Contains(log.String(), "case collision") &&
		!strings.Contains(log.String(), "case-collision") &&
		!strings.Contains(log.String(), "collision") {
		t.Logf("note: collision log line not found in stderr capture; output:\n%s", log.String())
	}
}

var (
	_ = context.TODO
	_ = filepath.Join
)

func httpDelete(t *testing.T, url string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodDelete, url, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Origin", originFor(t, url))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("DELETE %s: %v", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp.StatusCode, respBody
}

func treeContainsNoteID(nodes []map[string]any, id string) bool {
	for _, n := range nodes {
		if k, _ := n["kind"].(string); k == "note" {
			if v, _ := n["id"].(string); v == id {
				return true
			}
		}

		if children, ok := n["children"].([]any); ok {
			converted := make([]map[string]any, 0, len(children))
			for _, c := range children {
				if cm, ok := c.(map[string]any); ok {
					converted = append(converted, cm)
				}
			}
			if treeContainsNoteID(converted, id) {
				return true
			}
		}
	}
	return false
}

func findFolderNode(nodes []map[string]any, folderPath string) map[string]any {
	for _, n := range nodes {
		if k, _ := n["kind"].(string); k == "folder" {
			if p, _ := n["path"].(string); p == folderPath {
				return n
			}
		}
	}
	return nil
}

func TestSmoke_Phase3_NoteCRUD(t *testing.T) {
	dataDir := t.TempDir()
	addr := pickFreePort(t)
	cmd, log := spawn(t, dataDir, addr, nil)
	defer killAndWait(t, cmd, log)

	if err := waitForListener(t, addr, 10*time.Second); err != nil {
		t.Fatalf("listener never came up; output:\n%s", log.String())
	}

	base := "http://" + addr + "/api/v1"
	notesDir := filepath.Join(dataDir, "notes")

	createBody, _ := json.Marshal(map[string]string{"parent_path": "", "title": "smoke-alpha"})
	status, body := httpPost(t, base+"/notes", createBody)
	if status != 201 {
		t.Fatalf("POST /notes status: got %d, want 201; body=%s", status, body)
	}
	var summary struct {
		ID        string `json:"id"`
		Path      string `json:"path"`
		Title     string `json:"title"`
		UpdatedAt string `json:"updated_at"`
	}
	if err := json.Unmarshal(body, &summary); err != nil {
		t.Fatalf("unmarshal create response: %v; body=%s", err, body)
	}
	if summary.Path != "smoke-alpha.md" {
		t.Errorf("create path: got %q, want %q", summary.Path, "smoke-alpha.md")
	}
	if summary.ID == "" {
		t.Errorf("create response missing id; body=%s", body)
	}
	id := summary.ID

	status, body = httpGet(t, base+"/notes/"+id)
	if status != 200 {
		t.Fatalf("GET /notes/{id} status: got %d, want 200; body=%s", status, body)
	}
	var note struct {
		Content string `json:"content"`
		ID      string `json:"id"`
		Path    string `json:"path"`
	}
	if err := json.Unmarshal(body, &note); err != nil {
		t.Fatalf("unmarshal note: %v; body=%s", err, body)
	}

	wantScaffoldPrefix := "---\ntags: []\n---"
	if !strings.HasPrefix(note.Content, wantScaffoldPrefix) {
		t.Errorf("new note content: got %q, want prefix %q (TAGS-EXT-01 scaffold)", note.Content, wantScaffoldPrefix)
	}

	status, body = httpGet(t, base+"/tree")
	if status != 200 {
		t.Fatalf("GET /tree status: got %d, want 200; body=%s", status, body)
	}
	var tree struct {
		Root []map[string]any `json:"root"`
	}
	if err := json.Unmarshal(body, &tree); err != nil {
		t.Fatalf("unmarshal tree: %v; body=%s", err, body)
	}
	if !treeContainsNoteID(tree.Root, id) {
		t.Errorf("GET /tree did not contain note id %s; body=%s", id, body)
	}

	moveBody, _ := json.Marshal(map[string]string{"new_path": "smoke-beta.md"})
	status, body = httpPost(t, base+"/notes/"+id+"/move", moveBody)
	if status != 200 {
		t.Fatalf("POST /notes/{id}/move status: got %d, want 200; body=%s", status, body)
	}
	var moved struct {
		ID   string `json:"id"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(body, &moved); err != nil {
		t.Fatalf("unmarshal move response: %v; body=%s", err, body)
	}
	if moved.Path != "smoke-beta.md" {
		t.Errorf("move path: got %q, want %q", moved.Path, "smoke-beta.md")
	}

	if _, err := os.Stat(filepath.Join(notesDir, "smoke-alpha.md")); !os.IsNotExist(err) {
		t.Errorf("expected smoke-alpha.md gone after move, stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(notesDir, "smoke-beta.md")); err != nil {
		t.Errorf("expected smoke-beta.md to exist after move, stat err=%v", err)
	}

	status, body = httpDelete(t, base+"/notes/"+id)
	if status != 204 {
		t.Fatalf("DELETE /notes/{id} status: got %d, want 204; body=%s", status, body)
	}

	status, body = httpGet(t, base+"/notes/"+id)
	if status != 404 {
		t.Errorf("GET /notes/{id} after delete: got %d, want 404; body=%s", status, body)
	}

	if _, err := os.Stat(filepath.Join(notesDir, "smoke-beta.md")); !os.IsNotExist(err) {
		t.Errorf("expected smoke-beta.md gone post-delete, stat err=%v", err)
	}
}

func TestSmoke_Phase3_FolderCRUD(t *testing.T) {
	dataDir := t.TempDir()
	addr := pickFreePort(t)
	cmd, log := spawn(t, dataDir, addr, nil)
	defer killAndWait(t, cmd, log)

	if err := waitForListener(t, addr, 10*time.Second); err != nil {
		t.Fatalf("listener never came up; output:\n%s", log.String())
	}

	base := "http://" + addr + "/api/v1"
	notesDir := filepath.Join(dataDir, "notes")

	createFolder, _ := json.Marshal(map[string]string{"parent_path": "", "name": "projects"})
	status, body := httpPost(t, base+"/folders", createFolder)
	if status != 201 {
		t.Fatalf("POST /folders status: got %d, want 201; body=%s", status, body)
	}
	var folder struct {
		Kind string `json:"kind"`
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(body, &folder); err != nil {
		t.Fatalf("unmarshal folder: %v; body=%s", err, body)
	}
	if folder.Path != "projects" {
		t.Errorf("create folder path: got %q, want %q", folder.Path, "projects")
	}
	if folder.Kind != "folder" {
		t.Errorf("folder kind: got %q, want %q", folder.Kind, "folder")
	}

	createNote, _ := json.Marshal(map[string]string{"parent_path": "projects", "title": "design"})
	status, body = httpPost(t, base+"/notes", createNote)
	if status != 201 {
		t.Fatalf("POST /notes (in folder) status: got %d, want 201; body=%s", status, body)
	}
	var noteSummary struct {
		ID   string `json:"id"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(body, &noteSummary); err != nil {
		t.Fatalf("unmarshal note: %v; body=%s", err, body)
	}
	if noteSummary.Path != "projects/design.md" {
		t.Errorf("nested note path: got %q, want %q", noteSummary.Path, "projects/design.md")
	}

	moveFolder, _ := json.Marshal(map[string]string{"old_path": "projects", "new_path": "work"})
	status, body = httpPost(t, base+"/folders/move", moveFolder)
	if status != 200 {
		t.Fatalf("POST /folders/move status: got %d, want 200; body=%s", status, body)
	}
	var moved struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(body, &moved); err != nil {
		t.Fatalf("unmarshal folder move: %v; body=%s", err, body)
	}
	if moved.Path != "work" {
		t.Errorf("moved folder path: got %q, want %q", moved.Path, "work")
	}

	status, body = httpGet(t, base+"/tree")
	if status != 200 {
		t.Fatalf("GET /tree after folder-move status: got %d; body=%s", status, body)
	}
	var tree struct {
		Root []map[string]any `json:"root"`
	}
	if err := json.Unmarshal(body, &tree); err != nil {
		t.Fatalf("unmarshal tree: %v; body=%s", err, body)
	}
	work := findFolderNode(tree.Root, "work")
	if work == nil {
		t.Fatalf("GET /tree missing 'work' folder after move; body=%s", body)
	}

	children, _ := work["children"].([]any)
	foundDesign := false
	for _, c := range children {
		cm, ok := c.(map[string]any)
		if !ok {
			continue
		}
		if k, _ := cm["kind"].(string); k != "note" {
			continue
		}
		if p, _ := cm["path"].(string); p == "work/design.md" {
			foundDesign = true
		}
	}
	if !foundDesign {
		t.Errorf("'work/design.md' missing from /tree work folder children; body=%s", body)
	}

	if _, err := os.Stat(filepath.Join(notesDir, "projects")); !os.IsNotExist(err) {
		t.Errorf("expected projects/ gone after move, stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(notesDir, "work", "design.md")); err != nil {
		t.Errorf("expected work/design.md after move, stat err=%v", err)
	}

	// Soft delete: deleting a non-empty folder moves the whole
	// subtree into <dataDir>/.trash/ and returns 204 regardless of the recursive
	// flag — the prior 409 folder_not_empty guard is gone.
	status, body = httpDelete(t, base+"/folders?path=work&recursive=false")
	if status != 204 {
		t.Fatalf("DELETE non-empty folder (soft-delete): got %d, want 204; body=%s",
			status, body)
	}

	if _, err := os.Stat(filepath.Join(notesDir, "work")); !os.IsNotExist(err) {
		t.Errorf("expected work/ gone from notes after soft-delete, stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, ".trash", "work", "design.md")); err != nil {
		t.Errorf("expected work/design.md moved to .trash/ after soft-delete, stat err=%v", err)
	}
	status, body = httpGet(t, base+"/notes")
	if status != 200 {
		t.Fatalf("GET /notes after folder-delete: got %d; body=%s", status, body)
	}
	var listOut struct {
		Notes []struct {
			Path string `json:"path"`
		} `json:"notes"`
	}
	if err := json.Unmarshal(body, &listOut); err != nil {
		t.Fatalf("unmarshal /notes: %v; body=%s", err, body)
	}
	for _, n := range listOut.Notes {
		if strings.HasPrefix(n.Path, "work/") {
			t.Errorf("GET /notes still lists work/-prefixed note after recursive delete: %q", n.Path)
		}
	}
}

func TestSmoke_Phase3_TreeProjection(t *testing.T) {
	dataDir := t.TempDir()
	addr := pickFreePort(t)
	cmd, log := spawn(t, dataDir, addr, nil)
	defer killAndWait(t, cmd, log)

	if err := waitForListener(t, addr, 10*time.Second); err != nil {
		t.Fatalf("listener never came up; output:\n%s", log.String())
	}

	base := "http://" + addr + "/api/v1"

	for _, name := range []string{"beta", "alpha"} {
		body, _ := json.Marshal(map[string]string{"parent_path": "", "name": name})
		status, respBody := httpPost(t, base+"/folders", body)
		if status != 201 {
			t.Fatalf("POST /folders %s: got %d; body=%s", name, status, respBody)
		}
	}

	type seed struct {
		parent string
		title  string
	}
	seeds := []seed{
		{"alpha", "first"},
		{"alpha", "second"},
		{"beta", "third"},
		{"beta", "fourth"},
		{"", "root-note"},
	}
	for _, s := range seeds {
		body, _ := json.Marshal(map[string]string{"parent_path": s.parent, "title": s.title})
		status, respBody := httpPost(t, base+"/notes", body)
		if status != 201 {
			t.Fatalf("POST /notes parent=%q title=%q: got %d; body=%s",
				s.parent, s.title, status, respBody)
		}
	}

	status, body := httpGet(t, base+"/tree")
	if status != 200 {
		t.Fatalf("GET /tree status: got %d; body=%s", status, body)
	}
	var tree struct {
		Root []map[string]any `json:"root"`
	}
	if err := json.Unmarshal(body, &tree); err != nil {
		t.Fatalf("unmarshal tree: %v; body=%s", err, body)
	}

	folderNames := []string{}
	noteCount := 0
	rootKindOrder := []string{}
	for _, n := range tree.Root {
		k, _ := n["kind"].(string)
		rootKindOrder = append(rootKindOrder, k)
		switch k {
		case "folder":
			name, _ := n["name"].(string)
			folderNames = append(folderNames, name)

			if _, hasPath := n["path"].(string); !hasPath {
				t.Errorf("folder node missing path: %v", n)
			}
		case "note":
			noteCount++

			if _, hasID := n["id"].(string); !hasID {
				t.Errorf("note node missing id: %v", n)
			}
			if _, hasPath := n["path"].(string); !hasPath {
				t.Errorf("note node missing path: %v", n)
			}
			if _, hasTitle := n["title"].(string); !hasTitle {
				t.Errorf("note node missing title: %v", n)
			}
			if _, hasUpdatedAt := n["updated_at"].(string); !hasUpdatedAt {
				t.Errorf("note node missing updated_at: %v", n)
			}
		default:
			t.Errorf("unknown kind %q at root: %v", k, n)
		}
	}

	sawNote := false
	for _, k := range rootKindOrder {
		if k == "note" {
			sawNote = true
		} else if k == "folder" && sawNote {
			t.Errorf("ordering violation: folder appears AFTER a note at root: %v", rootKindOrder)
			break
		}
	}

	if len(folderNames) < 2 {
		t.Fatalf("expected ≥ 2 root folders, got %v", folderNames)
	}
	if folderNames[0] != "alpha" || folderNames[1] != "beta" {
		t.Errorf("folder ordering: got %v, want alpha,beta first", folderNames)
	}

	if noteCount < 2 {
		t.Errorf("expected ≥ 2 root-level notes (scratchpad + root-note), got %d", noteCount)
	}

	alpha := findFolderNode(tree.Root, "alpha")
	if alpha == nil {
		t.Fatalf("alpha folder not found in /tree root")
	}
	children, _ := alpha["children"].([]any)
	titles := []string{}
	for _, c := range children {
		cm, ok := c.(map[string]any)
		if !ok {
			continue
		}
		if k, _ := cm["kind"].(string); k != "note" {
			continue
		}
		if title, _ := cm["title"].(string); title != "" {
			titles = append(titles, title)
		}
	}
	if len(titles) != 2 || titles[0] != "first" || titles[1] != "second" {
		t.Errorf("alpha note ordering: got %v, want [first second]", titles)
	}
}
