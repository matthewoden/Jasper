# ADR-0035 — Attachment references are percent-encoded at insertion

**Status:** Accepted (v1.4)

## Context

The upload path inserted an attachment reference by interpolating the filename straight into markdown:

```markdown
![holiday photo.png](attachments/holiday photo.png)
```

CommonMark forbids an ASCII space in an undelimited link destination, so that is **not an image** to any conformant parser — GitHub, VS Code, `pandoc` and goldmark all render it as literal text. Jasper rendered it anyway, because the editor widgets locate references with a regex (`IMG_RE`, `/!\[([^\]]*)\]\((attachments\/[^)]+)\)/`) rather than through the parser.

So a note looked correct inside Jasper and was broken everywhere else. That inverts the reason notes are plain `.md` on disk ([ADR-0001](./0001-filesystem-is-the-source-of-truth.md), PROJECT §Core Value): the file is only portable if other tools can read it. And filenames with spaces are not an edge case — a dragged-in OS file keeps whatever name it had.

It also had a second-order effect. The attachment relocation added in [ADR-0034](./0034-attachments-travel-with-the-note.md) finds references with a goldmark AST walk, so it could not see these at all: exactly the filenames most likely to need escaping were the ones silently left behind on a move.

## Decision

**The destination is percent-encoded when the reference is written; the alt text keeps the human-readable filename.**

```markdown
![holiday photo.png](attachments/holiday%20photo.png)
```

Encoding is per path *segment*, so separators survive. **Parentheses are escaped on top of `encodeURIComponent`**, which leaves them alone: an unbalanced `)` ends a destination early for CommonMark *and* for the widgets' own `[^)]+` match.

Both widgets **decode before re-encoding** when building a request URL. Re-encoding an already-encoded reference asks the server for a file whose name literally contains `%20`. One helper — `frontend/src/lib/attachmentRef.ts` — owns encode, decode and URL construction, because these three have to agree and previously did not.

On the server, `markdown.AttachmentRef` carries both forms: `Raw` as written in the note, `Path` decoded. Filesystem work uses `Path`; editing the note's text uses `Raw`.

## Rationale

Percent-encoding is what the format already specifies, and the serving side needed no change — the widget already passed its filename through `encodeURIComponent`, and the route already decoded. The bug was entirely on the insertion side writing something it then only it could read.

Two alternatives were rejected:

- **Angle-bracket destinations** — `![x](<holiday photo.png>)`. Also valid CommonMark and more readable in source. Rejected because every existing consumer would need teaching: both widget regexes, the goldmark walk's assumptions, and any future extractor. Percent-encoding needs no parser to learn a second shape.
- **Sanitize the filename on upload** — replace spaces with hyphens. Simplest of all and sidesteps encoding everywhere. Rejected because it renames the user's file on disk to suit the reference format, which is backwards when the filesystem is the source of truth, and it silently diverges the attachment's name from what they dropped.

Keeping the alt text unencoded matters: it is what a human reads in source and what the missing-file fallback displays.

## Consequences

- **`ExtractAttachmentRefs` returns a struct, not a string.** Two near-identical strings now travel together, and picking the wrong one fails silently rather than loudly — the `-N` rewrite keyed on `Path` substitutes nothing and leaves the note pointing at the file it collided with. Covered by a test proven to fail when keyed on `Path`.
- **An unencoded reference still resolves.** `decodeAttachmentFilename` tolerates one, and `ExtractAttachmentRefs` accepts either form, so hand-authored references and any written before this change keep working — they are simply not portable, which they never were.
- **No repair pass for existing references.** Pre-launch ([ADR-0024](./0024-pre-launch-no-migration-burden.md)); a developer vault may hold some, and re-inserting them is acceptable.
- **A lone `%` in a filename is a literal, not an escape.** `decodeURIComponent` throws on it; the helper catches and returns the raw text. A file genuinely named `100%.png` resolves, but a name mixing a literal `%` with real escapes is ambiguous and not handled.
- **The widgets still find references by regex**, not through the parser. Encoding narrows the gap — the two now agree on everything the upload path produces — but a hand-authored reference the regex matches and CommonMark rejects would still render only in Jasper. Closing that means teaching the widgets to read the syntax tree, which is a larger change than this one.
- **Nested attachment paths remain unsupported** by the serving route, which takes one filename segment. `encodeAttachmentPath` preserves separators, so the reference text would survive, but nothing in Jasper creates a nested attachment path.

## Verification

`frontend/src/lib/attachmentRef.test.ts` covers encoding (spaces, separators preserved, parentheses, an unbalanced `)`), decoding (encoded, unencoded, lone `%`), and that a written reference round-trips to the same request URL as an unencoded one. `frontend/src/lib/useAttachmentUpload.test.ts` asserts the inserted markdown for images and non-images, that a name needing no escaping is byte-identical, and that the result is matchable by the widgets' own regex and decodes back to the original filename.

`backend/internal/markdown/attachments_test.go` pairs the two assertions that matter: an encoded destination parses and yields `Raw` + decoded `Path`, and an **unencoded** space yields no reference at all — which is the proof that the old form was never valid markdown. `backend/internal/api/attachments_move_test.go` covers relocating an escaped filename across folders and the `-N` collision on an escaped name, the latter proven to fail when the rewrite is keyed on the decoded path.
