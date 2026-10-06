package notes

import "testing"

func TestParseItemRef(t *testing.T) {
	t.Parallel()
	const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
	cases := []struct {
		in      string
		want    ItemRef
		wantErr bool
	}{
		{in: ulid, want: ItemRef{Namespace: RefNamespace, Kind: RefKindNote, ID: ulid}},
		{in: " " + ulid + " ", want: ItemRef{Namespace: RefNamespace, Kind: RefKindNote, ID: ulid}},
		{in: "jasper:note/" + ulid, want: ItemRef{Namespace: RefNamespace, Kind: RefKindNote, ID: ulid}},
		{in: "sha256-0123456789abcdef", want: ItemRef{Namespace: RefNamespace, Kind: RefKindBlob, ID: "sha256-0123456789abcdef"}},
		{in: "jasper:blob/sha256-0123456789abcdef", want: ItemRef{Namespace: RefNamespace, Kind: RefKindBlob, ID: "sha256-0123456789abcdef"}},
		{in: "jasper:title/Road map/2026", want: ItemRef{Namespace: RefNamespace, Kind: RefKindTitle, ID: "Road map/2026"}},
		{in: "ado:workitem/12345", want: ItemRef{Namespace: "ado", Kind: "workitem", ID: "12345"}},
		{in: "file:/Users/me/doc.pdf", want: ItemRef{Namespace: "file", ID: "/Users/me/doc.pdf"}},
		{in: "", wantErr: true},
		{in: "not-an-id", wantErr: true},
		{in: "foo:bar", wantErr: true},
		{in: "Ado:Workitem/1", wantErr: true},
	}
	for _, tc := range cases {
		got, err := ParseItemRef(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("ParseItemRef(%q) = %+v, want an error", tc.in, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("ParseItemRef(%q) = %+v, %v; want %+v", tc.in, got, err, tc.want)
			continue
		}
		if again, err := ParseItemRef(got.String()); err != nil || again != got {
			t.Errorf("%q did not round-trip through %q: %+v, %v", tc.in, got.String(), again, err)
		}
	}
}
