// Spike fixtures — representative markdown the spike's vitest suites
// run the decoration plugin against. Kept tiny and deterministic so
// tree-iteration assertions stay readable.
//
// Each export targets one or two specific D-XX decisions; comments
// tag the linkage so downstream plans (05-07, 05-08) can grow these
// fixtures without re-deriving the intent.
export const HEADING_DOC = `# Heading 1
Body paragraph after the heading.

## Heading 2
More body.`;

export const EMPHASIS_DOC = `Plain text with **bold** and *italic*.
Another **strong** word here.`;

export const FRONTMATTER_DOC = `---
title: Test note
tags: [foo, bar]
---
# Body
Paragraph.`;

export const CODE_FENCE_DOC = `Body before fence.

\`\`\`typescript
const x = **not bold**;
const y: number = 1;
\`\`\`

Body after fence.`;

export const INLINE_CODE_DOC = `Some \`**not bold inside code**\` here.`;

export const MULTI_LINE_SELECTION_DOC = `# Heading A
body
## Heading B
body
### Heading C`;
