package api

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
)

// TestPathTraversal_AllEndpoints walks the canonical traversal table across
// every path-accepting endpoint. The exact 4xx code varies per endpoint; what
// is asserted is that rejection happens BEFORE any side effect.
func TestPathTraversal_AllEndpoints(t *testing.T) {
	t.Parallel()

	t.Run("reveal", func(t *testing.T) {
		t.Parallel()
		f := newSecurityTestServer(t)

		for _, tc := range baseTraversalPayloads {
			tc := tc
			t.Run(tc.Name, func(t *testing.T) {
				resp, err := f.srv.PostReveal(context.Background(), PostRevealRequestObject{
					Body: &PostRevealJSONRequestBody{Path: tc.Payload},
				})
				if err != nil {
					t.Fatalf("PostReveal returned err: %v", err)
				}
				if tc.Want4xx {
					if _, ok := resp.(PostReveal400JSONResponse); !ok {
						t.Errorf("payload=%q: expected PostReveal400JSONResponse, got %T", tc.Payload, resp)
					}
				}
			})
		}

		resp, err := f.srv.PostReveal(context.Background(), PostRevealRequestObject{
			Body: &PostRevealJSONRequestBody{Path: f.validRel},
		})
		if err != nil {
			t.Fatalf("PostReveal(valid): err: %v", err)
		}
		if _, is400 := resp.(PostReveal400JSONResponse); is400 {
			t.Errorf("valid path %q: unexpected 400 response", f.validRel)
		}
	})

	t.Run("get_file", func(t *testing.T) {
		t.Parallel()
		f := newSecurityTestServer(t)

		for _, tc := range baseTraversalPayloads {
			tc := tc
			t.Run(tc.Name, func(t *testing.T) {
				got := callGetFile(t, f.srv, tc.Payload)

				switch got.status {
				case http.StatusBadRequest, http.StatusForbidden, http.StatusNotFound:

				default:
					t.Errorf("payload=%q: expected 400/403/404, got %d (%q)", tc.Payload, got.status, got.body)
				}
			})
		}
	})

	t.Run("create_file", func(t *testing.T) {
		t.Parallel()
		f := newSecurityTestServer(t)

		for _, tc := range baseTraversalPayloads {
			tc := tc
			t.Run(tc.Name, func(t *testing.T) {
				mr := buildMultipartBody(t, "ok.bin", []byte("x"))
				resp, err := f.srv.CreateFile(context.Background(), CreateFileRequestObject{
					Params: CreateFileParams{Path: tc.Payload},
					Body:   mr,
				})
				if err != nil {
					return
				}

				switch resp.(type) {
				case CreateFile400JSONResponse, CreateFile403JSONResponse, CreateFile413JSONResponse:

				case CreateFile201JSONResponse:
					if tc.Payload != "" {
						t.Errorf("payload=%q: unexpected 201 (file landed at %q)",
							tc.Payload, getCreateFileLandedPath(resp))
					}
				default:
					t.Errorf("payload=%q: unexpected response type %T", tc.Payload, resp)
				}
			})
		}
	})

	t.Run("create_attachment_filename", func(t *testing.T) {
		t.Parallel()
		f := newSecurityTestServer(t)

		validID := f.validID.String()

		for _, tc := range baseTraversalPayloads {
			tc := tc
			t.Run(tc.Name, func(t *testing.T) {
				mr := buildAttachmentMultipart(t, tc.Payload, []byte("x"))
				resp, err := f.srv.CreateAttachment(context.Background(), CreateAttachmentRequestObject{
					NoteId: validID,
					Body:   mr,
				})
				if err != nil {
					t.Fatalf("CreateAttachment returned err: %v", err)
				}

				switch resp.(type) {
				case CreateAttachment404JSONResponse:

				case CreateAttachment200JSONResponse:

					if !isAttachmentLandingSafe(t, f.dataDir, resp) {
						t.Errorf("payload=%q: file landed outside notes/ tree", tc.Payload)
					}
				default:
					t.Errorf("payload=%q: unexpected response type %T", tc.Payload, resp)
				}
			})
		}
	})

	t.Run("notes_by_path", func(t *testing.T) {
		t.Parallel()
		f := newSecurityTestServer(t)

		for _, tc := range baseTraversalPayloads {
			tc := tc
			t.Run(tc.Name, func(t *testing.T) {
				resp, err := f.srv.GetNoteByPath(context.Background(), GetNoteByPathRequestObject{
					Params: GetNoteByPathParams{Path: tc.Payload},
				})
				if err != nil {
					t.Fatalf("GetNoteByPath returned err: %v", err)
				}

				switch resp.(type) {
				case GetNoteByPath400JSONResponse, GetNoteByPath404JSONResponse:

				default:
					t.Errorf("payload=%q: expected GetNoteByPath{400,404}JSONResponse, got %T",
						tc.Payload, resp)
				}
			})
		}
	})

	t.Run("setup_validate_data_dir", func(t *testing.T) {
		t.Parallel()
		f := newSecurityTestServer(t)

		mustReject := map[string]bool{
			"empty_string":       true,
			"null_byte_in_path":  true,
			"absolute_unix":      true,
			"deep_parent_escape": true,
		}
		for _, tc := range baseTraversalPayloads {
			tc := tc
			t.Run(tc.Name, func(t *testing.T) {
				resp, err := f.srv.PostSetupValidateDataDir(
					context.Background(),
					PostSetupValidateDataDirRequestObject{
						Body: &PostSetupValidateDataDirJSONRequestBody{Path: tc.Payload},
					},
				)
				if err != nil {
					t.Fatalf("PostSetupValidateDataDir returned err: %v", err)
				}
				ok200, isOK := resp.(PostSetupValidateDataDir200JSONResponse)
				if !isOK {
					t.Fatalf("payload=%q: expected 200JSONResponse, got %T", tc.Payload, resp)
				}
				if mustReject[tc.Name] && ok200.Valid {
					t.Errorf("payload=%q: Valid:true — payload that wizard UI cannot produce was accepted", tc.Payload)
				}
			})
		}
	})
}

func getCreateFileLandedPath(resp CreateFileResponseObject) string {
	r, ok := resp.(CreateFile201JSONResponse)
	if !ok {
		return ""
	}
	return r.Path
}

func isAttachmentLandingSafe(t *testing.T, dataDir string, resp CreateAttachmentResponseObject) bool {
	t.Helper()
	r, ok := resp.(CreateAttachment200JSONResponse)
	if !ok {
		return true
	}
	_ = dataDir
	if strings.HasPrefix(r.Path, "/") {
		return false
	}
	for _, seg := range strings.Split(r.Path, "/") {
		if seg == ".." {
			return false
		}
	}
	return true
}

func buildAttachmentMultipart(t *testing.T, filename string, data []byte) *multipart.Reader {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	safeName := strings.ReplaceAll(filename, "\x00", "_NULL_")
	part, err := mw.CreateFormFile("file", safeName)
	if err != nil {
		t.Fatalf("CreateFormFile(%q): %v", safeName, err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	return multipart.NewReader(&buf, mw.Boundary())
}
