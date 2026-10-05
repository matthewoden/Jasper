package markdown

// WikiLinkRef is one occurrence of a [[Title]] or [[Title|Alias]] in note
// content. Target is the raw title text (no [[…]] markers, no fragment).
// Fragment is the optional #Section suffix; empty string if absent.
//
// Aliases are not surfaced here — wiki-link resolution depends only on
// Target. The render layer reads aliases directly from the source text.
//
// Example: [[Meeting Notes#Action Items]] → {Target: "Meeting Notes", Fragment: "Action Items"}
// Example: [[Foo|the foo doc]]           → {Target: "Foo", Fragment: ""}
type WikiLinkRef struct {
	Target   string
	Fragment string
}

// ExtractWikilinks returns every title link in source order, duplicates
// included — the caller deduplicates. A ref-shaped target (IsRefTarget) is
// a reference, not a title, and is left to ExtractRefs.
func ExtractWikilinks(content []byte) []WikiLinkRef {
	var refs []WikiLinkRef
	for _, r := range ExtractRefs(content) {
		if r.Position < 0 || IsRefTarget(r.Target) {
			continue
		}
		refs = append(refs, WikiLinkRef{Target: r.Target, Fragment: r.Fragment})
	}
	return refs
}
