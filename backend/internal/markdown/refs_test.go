package markdown

import (
	"reflect"
	"testing"
)

func TestIsRefTarget(t *testing.T) {
	yes := []string{"ado:workitem/12345", "jasper:note/01ARZ3NDEKTSV4RRFFQ69G5FAV", "bt:task/abc-1", "file:/home/x/report.pdf", "file:C:\\x.pdf", "jasper:blob/sha256-0123456789abcdef", "ado:workitem/1#notes"}
	no := []string{"Meeting Notes", "ado:12345", "ADO:workitem/1", "ado:workitem/", "http://example.com/x", "file:", "notes/x.md", ""}
	for _, s := range yes {
		if !IsRefTarget(s) {
			t.Errorf("IsRefTarget(%q) = false", s)
		}
	}
	for _, s := range no {
		if IsRefTarget(s) {
			t.Errorf("IsRefTarget(%q) = true", s)
		}
	}
}

func TestExtractRefs(t *testing.T) {
	content := "---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\nrefs: [ado:workitem/99, 'bt:task/x', not a ref]\n---\n" +
		"# T\n\nSee [[Meeting Notes#Action Items]] and [[ado:workitem/12345|the ticket]].\n" +
		"![[jasper:blob/sha256-0123456789abcdef|shot.png]] then [[Foo|the foo doc]] and [[ado:workitem/1#notes]].\n" +
		"`[[in code]]`\n\n```\n[[fenced]]\n```\n"
	got := ExtractRefs([]byte(content))

	fmLen := len("---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\nrefs: [ado:workitem/99, 'bt:task/x', not a ref]\n---\n")
	line1 := fmLen + len("# T\n\n")
	line2 := line1 + len("See [[Meeting Notes#Action Items]] and [[ado:workitem/12345|the ticket]].\n")
	want := []Ref{
		{Target: "ado:workitem/99", Position: -1},
		{Target: "bt:task/x", Position: -1},
		{Target: "Meeting Notes", Fragment: "Action Items", Position: line1 + len("See ")},
		{Target: "ado:workitem/12345", Display: "the ticket", Position: line1 + len("See [[Meeting Notes#Action Items]] and ")},
		{Target: "jasper:blob/sha256-0123456789abcdef", Display: "shot.png", Position: line2, Embed: true},
		{Target: "Foo", Display: "the foo doc", Position: line2 + len("![[jasper:blob/sha256-0123456789abcdef|shot.png]] then ")},
		{Target: "ado:workitem/1#notes", Position: line2 + len("![[jasper:blob/sha256-0123456789abcdef|shot.png]] then [[Foo|the foo doc]] and ")},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ExtractRefs\n got: %+v\nwant: %+v", got, want)
	}
	for _, r := range got {
		if r.Position >= 0 && string(content[r.Position:r.Position+2]) != "[[" && string(content[r.Position:r.Position+3]) != "![[" {
			t.Errorf("Position %d of %q does not point at a link: %q", r.Position, r.Target, content[r.Position:r.Position+3])
		}
	}
}

func TestExtractRefs_Empty(t *testing.T) {
	if got := ExtractRefs(nil); got != nil {
		t.Errorf("ExtractRefs(nil) = %+v", got)
	}
	if got := ExtractRefs([]byte("plain text, no links")); got != nil {
		t.Errorf("ExtractRefs(no links) = %+v", got)
	}
}

// Title links still come out of ExtractWikilinks; ref-shaped targets do not,
// so a foreign ref never becomes a pending backlink titled after itself.
func TestExtractWikilinks_SkipsRefTargets(t *testing.T) {
	got := ExtractWikilinks([]byte("[[Alpha]] [[ado:workitem/1]] [[Beta#Sec]] ![[jasper:blob/sha256-00|x]]"))
	want := []WikiLinkRef{{Target: "Alpha"}, {Target: "Beta", Fragment: "Sec"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ExtractWikilinks = %+v, want %+v", got, want)
	}
}
