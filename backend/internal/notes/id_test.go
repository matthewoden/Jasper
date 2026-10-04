package notes

import (
	"errors"
	"regexp"
	"testing"
)

var ulidRE = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)

func TestNewID_IsCanonicalAndMonotonic(t *testing.T) {
	prev := NewID()
	if !ulidRE.MatchString(string(prev)) {
		t.Fatalf("NewID() = %q, want canonical ULID", prev)
	}
	for i := 0; i < 1000; i++ {
		next := NewID()
		if !ulidRE.MatchString(string(next)) {
			t.Fatalf("NewID() = %q, want canonical ULID", next)
		}
		if string(next) <= string(prev) {
			t.Fatalf("NewID() not monotonic: %q after %q", next, prev)
		}
		prev = next
	}
}

func TestParseID(t *testing.T) {
	good := string(NewID())
	cases := []struct {
		in   string
		want bool
	}{
		{good, true},
		{string(ScratchpadID), true},
		{"", false},
		{"00000000-0000-4000-a000-000000000001", false},
		{good[:25], false},
		{good + "0", false},
		{"01arz3ndektsv4rrffq69g5fav", false}, // lowercase is not canonical
		{"01ARZ3NDEKTSV4RRFFQ69G5FAI", false}, // I is not Crockford
		{"8ZZZZZZZZZZZZZZZZZZZZZZZZZ", false}, // overflows 128 bits
	}
	for _, c := range cases {
		id, err := ParseID(c.in)
		if c.want && (err != nil || string(id) != c.in) {
			t.Errorf("ParseID(%q) = %q, %v; want ok", c.in, id, err)
		}
		if !c.want && (err == nil || !errors.Is(err, ErrInvalidID) || id != "") {
			t.Errorf("ParseID(%q) = %q, %v; want ErrInvalidID", c.in, id, err)
		}
	}
}
