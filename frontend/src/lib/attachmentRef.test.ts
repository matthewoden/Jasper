import { describe, it, expect } from "vitest";
import {
  attachmentRequestUrl,
  decodeAttachmentFilename,
  encodeAttachmentPath,
} from "./attachmentRef";

describe("encodeAttachmentPath", () => {
  it("escapes a space so the destination is a legal markdown link", () => {
    expect(encodeAttachmentPath("attachments/holiday photo.png")).toBe(
      "attachments/holiday%20photo.png"
    );
  });

  it("leaves separators alone", () => {
    expect(encodeAttachmentPath("attachments/2026/holiday photo.png")).toBe(
      "attachments/2026/holiday%20photo.png"
    );
  });

  it("leaves a name needing no escaping untouched", () => {
    expect(encodeAttachmentPath("attachments/pic.png")).toBe(
      "attachments/pic.png"
    );
  });

  // encodeURIComponent leaves parens alone, and an unbalanced one ends the
  // destination early — for CommonMark and for the widgets' own [^)]+ match.
  it("escapes parentheses", () => {
    expect(encodeAttachmentPath("attachments/a(b).png")).toBe(
      "attachments/a%28b%29.png"
    );
  });

  it("escapes an unbalanced closing paren", () => {
    expect(encodeAttachmentPath("attachments/photo).png")).toBe(
      "attachments/photo%29.png"
    );
  });
});

describe("decodeAttachmentFilename", () => {
  it("strips the prefix and decodes", () => {
    expect(decodeAttachmentFilename("attachments/holiday%20photo.png")).toBe(
      "holiday photo.png"
    );
  });

  it("tolerates an unencoded reference", () => {
    expect(decodeAttachmentFilename("attachments/holiday photo.png")).toBe(
      "holiday photo.png"
    );
  });

  it("does not throw on a lone percent", () => {
    expect(decodeAttachmentFilename("attachments/100%.png")).toBe("100%.png");
  });
});

describe("attachmentRequestUrl", () => {
  it("single-encodes an already-encoded reference", () => {
    expect(attachmentRequestUrl("n1", "attachments/holiday%20photo.png")).toBe(
      "/api/v1/attachments/n1/holiday%20photo.png"
    );
  });

  it("encodes an unencoded reference to the same URL", () => {
    expect(attachmentRequestUrl("n1", "attachments/holiday photo.png")).toBe(
      "/api/v1/attachments/n1/holiday%20photo.png"
    );
  });

  it("round-trips what encodeAttachmentPath produced", () => {
    const written = encodeAttachmentPath("attachments/a b (1).png");
    expect(attachmentRequestUrl("n1", written)).toBe(
      `/api/v1/attachments/n1/${encodeURIComponent("a b (1).png")}`
    );
  });
});
