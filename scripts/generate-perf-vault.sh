#!/usr/bin/env bash
# scripts/generate-perf-vault.sh
#
# Deterministic synthetic vault generator for the 5-second cold-start
# gate. Writes <COUNT> .md files under <OUT_DIR>/notes/ with this locked
# distribution:
#
#   - 80% body-only (no frontmatter, no wiki-links)
#   - 15% tagged   (frontmatter "tags: [...]" with 1–3 tags from a 50-tag pool)
#   -  5% wiki-link (single inline [[note-NNNNN]] reference)
#
# Usage:
#   bash scripts/generate-perf-vault.sh [OUT_DIR=_perf-vault] [COUNT=5000]
#
# Output structure (matches Jasper's vault layout — files land directly under
# notes/, not under a subfolder, so the indexer treats them all as root-level
# notes for the most realistic 5k cold-start measurement):
#
#   <OUT_DIR>/notes/note-00001.md
#   <OUT_DIR>/notes/note-00002.md
#   ...
#
# Idempotency: if <OUT_DIR>/notes/ already exists, all *.md files inside are
# removed before regeneration. The script is safe to re-run.
#
# Output dir is .gitignored (_perf-vault/) so this stays a local-only artifact.
set -euo pipefail

OUT_DIR="${1:-_perf-vault}"
COUNT="${2:-5000}"
NOTES_DIR="$OUT_DIR/notes"

mkdir -p "$NOTES_DIR"
# Use find + -delete instead of `rm <dir>/*.md` so we don't choke on very
# large globs (`Argument list too long` on macOS at ~64KB).
find "$NOTES_DIR" -maxdepth 1 -type f -name '*.md' -delete 2>/dev/null || true

for i in $(seq 1 "$COUNT"); do
    n=$(printf "%05d" "$i")
    kind=$((i % 100))
    path="$NOTES_DIR/note-$n.md"
    if (( kind < 80 )); then
        # 80%: body only.
        cat > "$path" <<EOF
# Note $n

This is synthetic note number $n. Lorem ipsum dolor sit amet, consectetur
adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna
aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.
EOF
    elif (( kind < 95 )); then
        # 15%: frontmatter with 1–3 tags drawn from a 50-tag pool.
        tag_count=$(((i % 3) + 1))
        tags=""
        for t in $(seq 1 "$tag_count"); do
            tag="topic-$(((i + t) % 50))"
            if [[ -z "$tags" ]]; then
                tags="$tag"
            else
                tags="$tags, $tag"
            fi
        done
        cat > "$path" <<EOF
---
tags: [$tags]
---

# Note $n

Synthetic tagged note. Topics: $tags.
EOF
    else
        # 5%: wiki-link reference to another note in the same vault.
        # Pick a deterministic target a few notes earlier (or wrap to note-00001
        # when i==1) so the link always resolves to an existing file in the vault.
        link_idx=$((((i - 2) % COUNT) + 1))
        link_n=$(printf "%05d" "$link_idx")
        cat > "$path" <<EOF
# Note $n

See also [[note-$link_n]] for context. Synthetic linked note that exercises
the wiki-link resolver during index build.
EOF
    fi
done

echo "Wrote $COUNT notes to $NOTES_DIR/"
