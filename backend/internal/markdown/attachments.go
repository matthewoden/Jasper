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

// ExtractAttachmentRefs returns every attachments/… destination the content
// embeds or links, deduplicated, in source order. Destinations are
// percent-decoded, so the returned strings are filesystem paths.
//
// Only the attachments/ prefix is recognised — it is what the upload path
// writes and what the editor resolves. A hand-authored ../elsewhere/pic.png is
// deliberately not returned; nothing in Jasper produces one and relocating it
// would need a resolver this has no business owning.
func ExtractAttachmentRefs(content []byte) []string {
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

	var refs []string
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

		ref := string(dest)
		if decoded, err := url.PathUnescape(ref); err == nil {
			ref = decoded
		}
		if !strings.HasPrefix(ref, AttachmentRefPrefix) {
			return goldmarkAst.WalkContinue, nil
		}
		// A ../ inside the tail would escape the attachments directory; the
		// caller joins these onto a vault-relative folder, so refuse here
		// rather than relying on canonicalization further down.
		if strings.Contains(ref, "..") {
			return goldmarkAst.WalkContinue, nil
		}
		if seen[ref] {
			return goldmarkAst.WalkContinue, nil
		}
		seen[ref] = true
		refs = append(refs, ref)

		return goldmarkAst.WalkContinue, nil
	})

	return refs
}
