package markdown

import (
	"reflect"
	"testing"
)

func TestExtractAttachmentRefs(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		content string
		want    []AttachmentRef
	}{
		{
			name:    "image embed",
			content: "# Note\n\n![pic.png](attachments/pic.png)\n",
			want:    []AttachmentRef{{Raw: "attachments/pic.png", Path: "attachments/pic.png"}},
		},
		{
			name:    "plain link to a non-image attachment",
			content: "See [report.pdf](attachments/report.pdf).\n",
			want:    []AttachmentRef{{Raw: "attachments/report.pdf", Path: "attachments/report.pdf"}},
		},
		{
			name:    "image and link together",
			content: "![a](attachments/a.png)\n\n[b](attachments/b.pdf)\n",
			want:    []AttachmentRef{{Raw: "attachments/a.png", Path: "attachments/a.png"}, {Raw: "attachments/b.pdf", Path: "attachments/b.pdf"}},
		},
		{
			name:    "duplicates collapse, source order kept",
			content: "![a](attachments/b.png)\n![a](attachments/a.png)\n![a](attachments/b.png)\n",
			want:    []AttachmentRef{{Raw: "attachments/b.png", Path: "attachments/b.png"}, {Raw: "attachments/a.png", Path: "attachments/a.png"}},
		},
		{
			name:    "percent-encoded destination keeps Raw and decodes Path",
			content: "![x](attachments/holiday%20photo.png)\n",
			want: []AttachmentRef{{
				Raw:  "attachments/holiday%20photo.png",
				Path: "attachments/holiday photo.png",
			}},
		},
		{
			name:    "encoded and unencoded forms of one file are one ref",
			content: "![a](attachments/holiday%20photo.png)\n\n[b](attachments/holiday%20photo.png)\n",
			want: []AttachmentRef{{
				Raw:  "attachments/holiday%20photo.png",
				Path: "attachments/holiday photo.png",
			}},
		},
		{
			name:    "an encoded traversal is refused",
			content: "![x](attachments/%2E%2E/%2E%2E/etc/passwd)\n",
			want:    nil,
		},
		{
			name:    "an unencoded space is not a CommonMark destination, so not a ref",
			content: "![x](attachments/holiday photo.png)\n",
			want:    nil,
		},
		{
			name:    "nested path under attachments",
			content: "![x](attachments/2026/jan/pic.png)\n",
			want:    []AttachmentRef{{Raw: "attachments/2026/jan/pic.png", Path: "attachments/2026/jan/pic.png"}},
		},
		{
			name:    "external and vault-relative destinations are ignored",
			content: "![x](https://example.com/a.png)\n![y](../elsewhere/b.png)\n![z](/abs/c.png)\n",
			want:    nil,
		},
		{
			name:    "traversal inside the tail is refused",
			content: "![x](attachments/../../etc/passwd)\n",
			want:    nil,
		},
		{
			name:    "fenced code block is not a reference",
			content: "```\n![x](attachments/pic.png)\n```\n",
			want:    nil,
		},
		{
			name:    "inline code span is not a reference",
			content: "Write `![x](attachments/pic.png)` to embed.\n",
			want:    nil,
		},
		{
			name:    "wiki-links are not attachment refs",
			content: "[[Some Note]]\n",
			want:    nil,
		},
		{
			name:    "frontmatter is skipped",
			content: "---\nimage: attachments/cover.png\n---\n\n# Note\n",
			want:    nil,
		},
		{
			name:    "empty content",
			content: "",
			want:    nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := ExtractAttachmentRefs([]byte(tc.content))
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("ExtractAttachmentRefs() = %#v, want %#v", got, tc.want)
			}
		})
	}
}
