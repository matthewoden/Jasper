/**
 * Tests for h1Extract — the client-side mirror of
 * backend/internal/markdown/title.go's ExtractTitle scanner. Used by
 * EditorPane (autosave H1 detection) + FileTree (post-rename H1
 * rewrite) to close Gap R2-6 (filename↔H1 bidirectional binding;
 * PROJECT.md Key Decision 2026-05-03 LOCKED).
 *
 * Coverage shape:
 *   - extractH1FromContent: 10 cases — happy path, no-H1, frontmatter
 *     (closed + unclosed), Unicode, leading blanks, edge whitespace.
 *   - sanitizeH1ForFilename: 9 cases — happy path, illegal chars,
 *     empty / whitespace-only, leading-dot, control chars.
 *   - rewriteH1: 6 cases — happy path, no-H1 no-op, frontmatter
 *     traversal, indented heading preservation, multi-paragraph
 *     untouched.
 *
 * The illegal-char regex MUST agree byte-for-byte with the regex in
 * RenameInput.validateRename (which itself mirrors the backend's
 * notes.validateBareName) — same set: / \ : * ? " < > | + ASCII
 * controls. Drift between client validators is the bug class this
 * module exists to prevent.
 */
import { describe, expect, it } from "vitest";

import {
  extractH1FromContent,
  rewriteH1,
  sanitizeH1ForFilename,
} from "./h1Extract";

describe("extractH1FromContent", () => {
  it("returns the H1 text without the '# ' prefix", () => {
    expect(extractH1FromContent("# Hello World\n\nbody")).toBe("Hello World");
  });

  it("returns null when no H1 is present (body-only)", () => {
    expect(extractH1FromContent("body without heading\nmore body")).toBe(null);
  });

  it("skips closed YAML frontmatter and returns the H1 below it", () => {
    expect(
      extractH1FromContent("---\ntitle: foo\n---\n# Real H1\nbody"),
    ).toBe("Real H1");
  });

  it("returns null on empty content", () => {
    expect(extractH1FromContent("")).toBe(null);
  });

  it("returns null when only an H2 is present (heading must be exactly '# ')", () => {
    expect(extractH1FromContent("## H2 Heading\nbody")).toBe(null);
  });

  it("returns null for '#tag' (hash without trailing space — not an ATX H1)", () => {
    expect(extractH1FromContent("#tag\nbody")).toBe(null);
  });

  it("tolerates leading blank lines before the H1", () => {
    expect(extractH1FromContent("\n\n# Tolerant\n")).toBe("Tolerant");
  });

  it("returns null when frontmatter never closes (consumed to EOF)", () => {
    expect(
      extractH1FromContent("---\nunclosed frontmatter\nstill in fm"),
    ).toBe(null);
  });

  it("preserves Unicode in the heading text verbatim", () => {
    expect(extractH1FromContent("# 设计\nbody")).toBe("设计");
  });

  it("trims extra spaces after '#' (TrimSpace applied)", () => {
    expect(extractH1FromContent("#  Spaces\n")).toBe("Spaces");
  });
});

describe("sanitizeH1ForFilename", () => {
  it("accepts a plain heading (happy path)", () => {
    expect(sanitizeH1ForFilename("my plan")).toEqual({
      ok: true,
      value: "my plan",
    });
  });

  it("rejects path separators ('/')", () => {
    const r = sanitizeH1ForFilename("my/plan");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/aren't allowed/i);
  });

  it("rejects an empty string", () => {
    const r = sanitizeH1ForFilename("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/i);
  });

  it("rejects whitespace-only (empty after trim)", () => {
    const r = sanitizeH1ForFilename("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/i);
  });

  it("rejects leading dot ('.hidden')", () => {
    const r = sanitizeH1ForFilename(".hidden");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/dot/i);
  });

  it("rejects colon (':' — illegal on Windows)", () => {
    const r = sanitizeH1ForFilename("a:b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/aren't allowed/i);
  });

  it("accepts dashes, underscores, and digits", () => {
    expect(sanitizeH1ForFilename("valid-name_123")).toEqual({
      ok: true,
      value: "valid-name_123",
    });
  });

  it("trims surrounding whitespace before validating", () => {
    expect(sanitizeH1ForFilename("  trim me  ")).toEqual({
      ok: true,
      value: "trim me",
    });
  });

  it("rejects ASCII control characters", () => {
    const r = sanitizeH1ForFilename("a\x00b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/aren't allowed/i);
  });
});

describe("rewriteH1", () => {
  it("rewrites the first '# ' line to the new heading", () => {
    expect(rewriteH1("# Original\n\nbody", "Renamed")).toBe(
      "# Renamed\n\nbody",
    );
  });

  it("returns content unchanged when no H1 is present (no auto-insert)", () => {
    expect(rewriteH1("body without heading\nmore", "Renamed")).toBe(
      "body without heading\nmore",
    );
  });

  it("returns content unchanged on empty input", () => {
    expect(rewriteH1("", "Renamed")).toBe("");
  });

  it("rewrites the H1 below YAML frontmatter and leaves the frontmatter intact", () => {
    expect(
      rewriteH1("---\ntitle: foo\n---\n# Old\nbody", "New"),
    ).toBe("---\ntitle: foo\n---\n# New\nbody");
  });

  it("preserves up to 3 leading spaces on an indented ATX heading", () => {
    expect(rewriteH1("  # Old\nbody", "New")).toBe("  # New\nbody");
  });

  it("only rewrites the FIRST H1, not subsequent ones", () => {
    expect(
      rewriteH1("# First\nbody\n# Second", "Renamed"),
    ).toBe("# Renamed\nbody\n# Second");
  });
});
