package markdown

import (
	"net/url"
	"strings"

	"github.com/yuin/goldmark"
	goldmarkAst "github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
	"go.abhg.dev/goldmark/frontmatter"
	"go.abhg.dev/goldmark/wikilink"
)

// AttachmentRefPrefix is the only reference form Jasper writes for an
// attachment: folder-relative to the note that embeds it.
const AttachmentRefPrefix = "attachments/"

// AttachmentRef is one attachments/… destination. Raw is the text exactly as
// it appears in the note; Path is that text percent-decoded, which is the path
// on disk. They differ whenever a filename needs escaping, so a caller doing
// filesystem work wants Path and a caller editing the note text wants Raw —
// substituting one for the other silently fails on any escaped filename.
type AttachmentRef struct {
	Raw  string
	Path string
}

// ExtractAttachmentRefs returns every attachments/… destination the content
// embeds or links, deduplicated by Path, in source order.
//
// Only the attachments/ prefix is recognised — it is what the upload path
// writes and what the editor resolves. A hand-authored ../elsewhere/pic.png is
// deliberately not returned; nothing in Jasper produces one and relocating it
// would need a resolver this has no business owning.
func ExtractAttachmentRefs(content []byte) []AttachmentRef {
	if len(content) == 0 {
		return nil
	}

	md := goldmark.New(
		goldmark.WithExtensions(
			&frontmatter.Extender{},
			&wikilink.Extender{},
		),
	)

	doc := md.Parser().Parse(text.NewReader(content))

	var refs []AttachmentRef
	seen := make(map[string]bool)
	_ = goldmarkAst.Walk(doc, func(n goldmarkAst.Node, entering bool) (goldmarkAst.WalkStatus, error) {
		if !entering {
			return goldmarkAst.WalkContinue, nil
		}

		var dest []byte
		switch node := n.(type) {
		case *goldmarkAst.Image:
			dest = node.Destination
		case *goldmarkAst.Link:
			dest = node.Destination
		default:
			return goldmarkAst.WalkContinue, nil
		}

		raw := string(dest)
		decoded := raw
		if unescaped, err := url.PathUnescape(raw); err == nil {
			decoded = unescaped
		}
		// Checked on both forms: a %2E%2E would slip a traversal past a test
		// against the raw text, and an encoded prefix past one against decoded.
		if !strings.HasPrefix(raw, AttachmentRefPrefix) || !strings.HasPrefix(decoded, AttachmentRefPrefix) {
			return goldmarkAst.WalkContinue, nil
		}
		// A ../ inside the tail would escape the attachments directory; the
		// caller joins these onto a vault-relative folder, so refuse here
		// rather than relying on canonicalization further down.
		if strings.Contains(raw, "..") || strings.Contains(decoded, "..") {
			return goldmarkAst.WalkContinue, nil
		}
		if seen[decoded] {
			return goldmarkAst.WalkContinue, nil
		}
		seen[decoded] = true
		refs = append(refs, AttachmentRef{Raw: raw, Path: decoded})

		return goldmarkAst.WalkContinue, nil
	})

	return refs
}
