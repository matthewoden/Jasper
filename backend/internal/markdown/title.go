// Package markdown holds markdown helpers shared by index and notes.
//
// It MUST stay a leaf package: index imports notes, so anything both need has
// to depend on nothing but stdlib or the cycle forms.
package markdown

import (
	"bufio"
	"bytes"
	"path/filepath"
	"strings"
)

// ExtractTitle returns the first H1, falling back to the filename without ".md".
//
// Titles come back VERBATIM — no capitalization, truncation or normalization —
// because wiki-link resolution has to match character-for-character.
//
// "#tag" with no space is not a heading (CommonMark §4.2), and the scanner
// buffer is 1 MiB so a single-100-KB-line file does not error out.
func ExtractTitle(content []byte, fallbackPath string) string {
	scanner := bufio.NewScanner(bytes.NewReader(content))

	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	inFrontmatter := false
	firstSignificantLineSeen := false

	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)

		if !firstSignificantLineSeen {
			if trimmed == "" {
				continue
			}
			firstSignificantLineSeen = true
			if trimmed == "---" {
				inFrontmatter = true
				continue
			}
		} else if inFrontmatter {
			if trimmed == "---" {
				inFrontmatter = false
			}
			continue
		}

		if strings.HasPrefix(trimmed, "# ") {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, "# "))
		}

		if trimmed != "" {
			break
		}
	}

	name := filepath.Base(fallbackPath)
	name = strings.TrimSuffix(name, ".md")
	return name
}
