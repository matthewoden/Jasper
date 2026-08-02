/**
 * Locked thread-of-trust proofs: malicious HTML is stripped, benign HTML survives.
 */
import { describe, expect, it } from "vitest";

import { sanitizeHtml } from "./sanitize";

describe("sanitizeHtml — XSS strip", () => {
  it("strips <script> tags entirely", () => {
    const out = sanitizeHtml("<p>hi</p><script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("hi");
  });

  it("strips inline event handlers (onerror, onload, onclick)", () => {
    const out = sanitizeHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert(1)");
  });

  it("strips javascript: URIs from href", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("alert(1)");
  });

  it("strips <iframe> tags", () => {
    const out = sanitizeHtml(
      '<iframe src="https://evil.example.com"></iframe>',
    );
    expect(out).not.toContain("<iframe");
  });

  it("strips <object> and <embed> tags", () => {
    const obj = sanitizeHtml('<object data="evil.swf"></object>');
    const emb = sanitizeHtml('<embed src="evil.swf">');
    expect(obj).not.toContain("<object");
    expect(emb).not.toContain("<embed");
  });

  it("strips <form> tags (no submission gadgets in render surfaces)", () => {
    const out = sanitizeHtml(
      '<form action="https://evil.example.com"><input></form>',
    );
    expect(out).not.toContain("<form");
  });

  it("strips data: URIs that try to smuggle script content", () => {
    const out = sanitizeHtml(
      '<a href="data:text/html,<script>alert(1)</script>">click</a>',
    );
    expect(out).not.toContain("<script");
  });

  it("strips on* attributes from any tag", () => {
    const out = sanitizeHtml(
      '<div onclick="alert(1)" onmouseover="leak()">x</div>',
    );
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onmouseover");
  });
});

describe("sanitizeHtml — benign HTML preserved", () => {
  it("preserves <p>, <strong>, <em>, <a> with safe href", () => {
    const input =
      '<p>Hello <strong>world</strong> and <em>others</em>. ' +
      '<a href="https://example.com" title="ext">link</a></p>';
    const out = sanitizeHtml(input);
    expect(out).toContain("<p>");
    expect(out).toContain("<strong>");
    expect(out).toContain("<em>");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('title="ext"');
  });

  it("preserves <img> with safe src + alt", () => {
    const out = sanitizeHtml(
      '<img src="https://example.com/x.png" alt="alt text">',
    );
    expect(out).toContain("<img");
    expect(out).toContain('src="https://example.com/x.png"');
    expect(out).toContain('alt="alt text"');
  });

  it("preserves class attributes (CSS hook for render surfaces)", () => {
    const out = sanitizeHtml('<span class="cm-keyword">if</span>');
    expect(out).toContain('class="cm-keyword"');
  });

  it("preserves blob: URLs (paired with the external-image widget from)", () => {
    const out = sanitizeHtml('<img src="blob:https://app.local/abc-123" alt="">');
    expect(out).toContain("blob:");
  });

  it("preserves relative URLs (wiki-links may render relative hrefs)", () => {
    const out = sanitizeHtml('<a href="/notes/foo.md">foo</a>');
    expect(out).toContain('href="/notes/foo.md"');
  });

  it("preserves <ul>, <ol>, <li> for list rendering", () => {
    const out = sanitizeHtml("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>one</li>");
  });

  it("preserves <code> and <pre> for code blocks", () => {
    const out = sanitizeHtml("<pre><code>const x = 1;</code></pre>");
    expect(out).toContain("<pre>");
    expect(out).toContain("<code>");
    expect(out).toContain("const x = 1;");
  });

  it("preserves <mark> for FTS5 search highlights (SEARCH-04)", () => {
    const out = sanitizeHtml("<p>foo <mark>bar</mark></p>");
    expect(out).toContain("<mark>bar</mark>");
  });
});

describe("sanitizeHtml — edge cases", () => {
  it("returns empty string on empty input", () => {
    expect(sanitizeHtml("")).toBe("");
  });

  it("returns plain text unchanged when no HTML tags", () => {
    expect(sanitizeHtml("just plain text")).toBe("just plain text");
  });

  it("does not throw on input with mismatched tags", () => {
    expect(() => sanitizeHtml("<p><span>unclosed")).not.toThrow();
  });
});
