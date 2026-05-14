package api

import "testing"

// TestAttachmentsUploadStorage — Plan 07-06 lands POST /attachments/{noteId}.
// Covers: storage layout per D-25 (root-level note → notes/attachments/;
// sub-folder note → notes/<dir>/attachments/), atomic write, MIME sniff,
// 413 on >100MB. SCAFFOLD ONLY.
func TestAttachmentsUploadStorage(t *testing.T) {
	t.Skip("scaffold — implemented in Plan 07-06 (attachments handler)")
}

// TestUniqueAttachmentName — Plan 07-06 lands the collision auto-rename.
// image.png → image-1.png → image-2.png (ATTACH-04). SCAFFOLD ONLY.
func TestUniqueAttachmentName(t *testing.T) {
	t.Skip("scaffold — implemented in Plan 07-06 (attachments handler)")
}

// TestAttachmentsSecurity — Plan 07-06 lands GET /attachments/{noteId}/{filename}
// path-traversal hardening (D-34, SECURITY-06). Covers: rejection of "..",
// path separators, symlinks via Lstat, files outside attachDir. SCAFFOLD ONLY.
func TestAttachmentsSecurity(t *testing.T) {
	t.Skip("scaffold — implemented in Plan 07-06 (attachments handler)")
}
