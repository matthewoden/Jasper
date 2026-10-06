package notes

import (
	"errors"
	"fmt"

	"github.com/oklog/ulid/v2"
)

// ID is a note's identity: a 26-character Crockford base32 ULID in its
// canonical uppercase form. It lives in the note's frontmatter, so it survives
// a rebuild of the derived index. The zero value is "no id".
type ID string

// ErrInvalidID is returned by ParseID for anything that is not a canonical ULID.
var ErrInvalidID = errors.New("notes: invalid note id")

// NewID mints a fresh, monotonic ULID.
func NewID() ID {
	return ID(ulid.Make().String())
}

// ParseID accepts exactly the canonical form: 26 uppercase Crockford base32
// characters that do not overflow 128 bits. Lowercase and other spellings are
// rejected so that two IDs are equal exactly when their strings are.
func ParseID(s string) (ID, error) {
	if len(s) != ulid.EncodedSize {
		return "", fmt.Errorf("%w: %q", ErrInvalidID, s)
	}
	for i := 0; i < len(s); i++ {
		if !isCrockfordUpper(s[i]) {
			return "", fmt.Errorf("%w: %q", ErrInvalidID, s)
		}
	}
	if _, err := ulid.ParseStrict(s); err != nil {
		return "", fmt.Errorf("%w: %q: %v", ErrInvalidID, s, err)
	}
	return ID(s), nil
}

func (id ID) String() string { return string(id) }

func isCrockfordUpper(c byte) bool {
	switch {
	case c >= '0' && c <= '9':
		return true
	case c >= 'A' && c <= 'Z':
		return c != 'I' && c != 'L' && c != 'O' && c != 'U'
	}
	return false
}
